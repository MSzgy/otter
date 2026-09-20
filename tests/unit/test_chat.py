import asyncio
import threading
import uuid

import httpx
import pytest
import respx

from otter.companion.chat import ChatService, ChatStore, openai_stream
from otter.core.config import LLMCfg
from otter.core.llm import LLMError


def llm():
    return LLMCfg(
        provider="openai",
        providers={"openai": {"model": "test-model", "base_url": "http://localhost:11434/v1"}},
    )


def request(session, text="hello"):
    return {"session_id": session, "text": text, "request_id": uuid.uuid4().hex}


def test_multiturn_persistence_and_delete(tmp_path):
    seen = []
    done = threading.Event()

    async def stream(_config, messages, _resolver):
        seen.append(messages)
        yield "Hello "
        yield "otter"

    service = ChatService(
        tmp_path / "chat.db",
        lambda _m, t: done.set() if t["status"] == "complete" else None,
        stream=stream,
    )
    session = service.store.new()["id"]
    try:
        service.send(request(session), llm())
        assert done.wait(3)
        done.clear()
        service.send(request(session, "remember me?"), llm())
        assert done.wait(3)
        assert [m["role"] for m in seen[1]] == ["system", "user", "assistant", "user"]
        assert seen[1][2]["content"] == "Hello otter"
        assert len(service.store.history(session)) == 4
    finally:
        service.close()
    reopened = ChatStore(tmp_path / "chat.db")
    assert reopened.history(session)[-1]["status"] == "complete"
    reopened.delete(session)
    assert reopened.sessions() == []


def test_cancel_closes_generator_and_drops_late_reply(tmp_path):
    chunk = threading.Event()
    canceled = threading.Event()
    done = threading.Event()
    calls = 0

    async def stream(_config, messages, _resolver):
        nonlocal calls
        calls += 1
        if calls == 1:
            try:
                yield "partial"
                await asyncio.sleep(30)
                yield "should never appear"
            finally:
                canceled.set()
        else:
            assert [m["role"] for m in messages] == ["system", "user"]
            yield "new answer"

    def emit(_method, t):
        if t["content"] == "partial":
            chunk.set()
        if t["status"] == "complete":
            done.set()

    service = ChatService(tmp_path / "chat.db", emit, stream=stream)
    session = service.store.new()["id"]
    try:
        turn = service.send(request(session), llm())
        assert chunk.wait(3)
        service.cancel(turn["id"])
        assert canceled.wait(3)
        assert service.snapshot()["status"] == "cancelled"
        service.send(request(session, "new question"), llm())
        assert done.wait(3)
        rows = service.store.history(session)
        assert rows[1]["content"] == "partial" and rows[1]["status"] == "cancelled"
        assert rows[-1]["content"] == "new answer"
    finally:
        service.close()


def test_crashed_turn_is_marked_interrupted_and_not_replayed(tmp_path):
    path = tmp_path / "chat.db"
    store = ChatStore(path)
    session = store.new()["id"]
    store.begin(session, "turn", "question")
    store.update("turn", "partial", "streaming")
    recovered = ChatStore(path)
    assert recovered.history(session)[-1]["status"] == "interrupted"


def test_duplicate_request_and_validation(tmp_path):
    async def stream(*_):
        await asyncio.sleep(20)
        yield "text"

    service = ChatService(tmp_path / "chat.db", lambda *_: None, stream=stream)
    session = service.store.new()["id"]
    try:
        req = request(session)
        service.send(req, llm())
        assert service.send(req, llm())["id"] == req["request_id"]
        assert len(service.store.history(session)) == 2
        with pytest.raises(LLMError, match="正在回复"):
            service.send(request(session), llm())
        with pytest.raises(LLMError):
            service.send(request(session, "x" * 6001), llm())
        service.delete(session)
        assert service.store.sessions() == []
    finally:
        service.close()


@respx.mock
def test_sse_parser_and_json_fallback():
    sse = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'
    route = respx.post("http://localhost:11434/v1/chat/completions").mock(
        return_value=httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})
    )

    async def collect():
        return "".join(
            [
                c
                async for c in openai_stream(
                    llm().provider_config(), [{"role": "user", "content": "Hi"}], None
                )
            ]
        )

    assert asyncio.run(collect()) == "你好"
    assert b'"stream":true' in route.calls.last.request.content
    route.mock(return_value=httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]}))
    assert asyncio.run(collect()) == "OK"
    route.mock(return_value=httpx.Response(401, text="secret key echoed by proxy"))
    with pytest.raises(LLMError, match="401") as exc:
        asyncio.run(collect())
    assert "secret" not in str(exc.value)


@respx.mock
def test_truncated_stream_does_not_look_complete():
    respx.post("http://localhost:11434/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            text='data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            headers={"content-type": "text/event-stream"},
        )
    )

    async def collect():
        return [c async for c in openai_stream(llm().provider_config(), [], None)]

    with pytest.raises(LLMError, match="未完成"):
        asyncio.run(collect())


def test_explicit_context_is_persisted_and_sent_only_when_attached(tmp_path):
    seen = []
    done = threading.Event()

    async def stream(_config, messages, _resolver):
        seen.append(messages)
        yield "OK"

    service = ChatService(
        tmp_path / "chat.db",
        lambda _m, t: done.set() if t["status"] == "complete" else None,
        stream=stream,
    )
    try:
        session = service.store.new()["id"]
        service.send(
            {**request(session), "context": "来源应用：测试编辑器\n选中文字：hello"}, llm()
        )
        assert done.wait(3)
        assert "测试编辑器" in seen[0][-1]["content"]
        assert service.store.history(session)[0]["context"].startswith("来源应用")
        done.clear()
        clean = service.store.new()["id"]
        service.send(request(clean), llm())
        assert done.wait(3)
        assert "测试编辑器" not in str(seen[-1])
    finally:
        service.close()


def test_chat_database_v1_migrates_without_losing_messages(tmp_path):
    import sqlite3

    path = tmp_path / "chat.db"
    with sqlite3.connect(path) as db:
        db.executescript("""
        CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated REAL NOT NULL);
        CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
          role TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,created REAL NOT NULL,
          error TEXT NOT NULL DEFAULT '');
        INSERT INTO conversations VALUES('s','existing',1);
        INSERT INTO messages VALUES('m','s','t','user','existing text','complete',1,'');
        """)
    store = ChatStore(path)
    rows = store.history("s")
    assert rows[0]["content"] == "existing text" and rows[0]["context"] == ""


def test_long_page_remains_available_for_immediate_followup(tmp_path):
    store = ChatStore(tmp_path / "chat.db")
    session = store.new()["id"]
    store.begin(session, "first", "总结页面", "PAGE_SOURCE:" + "x" * 20000)
    store.update("first", "a" * 90000, "complete")
    store.begin(session, "second", "再解释一下第二点")
    context = store.context(session, "second")
    assert "PAGE_SOURCE:" in context[1]["content"]
    assert len(context[2]["content"]) == 8000
    assert len(store.history(session)[1]["content"]) == 90000
