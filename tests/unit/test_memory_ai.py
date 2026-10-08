import asyncio
import json
import threading
import uuid

import pytest

from otter.companion.chat import ChatService
from otter.companion.memory import MemoryStore
from otter.companion.memory_ai import EXTRACT_SYSTEM, SELECT_SYSTEM, MemoryAI
from otter.core.config import LLMCfg


def model():
    return LLMCfg(
        provider="openai",
        providers={"openai": {"model": "test", "base_url": "http://127.0.0.1:1/v1"}},
    )


def test_suggestions_require_supported_evidence_and_valid_fields():
    async def stream(config, messages, resolver):
        assert messages[0]["content"] == EXTRACT_SYSTEM
        assert "PRIVATE_ATTACHMENT" not in json.dumps(messages)
        yield json.dumps(
            {
                "candidates": [
                    {
                        "title": "猫名字",
                        "content": "我的猫叫糯米",
                        "category": "fact",
                        "evidence": "我家猫叫糯米",
                    },
                    {
                        "title": "假事实",
                        "content": "我住在北京",
                        "category": "profile",
                        "evidence": "未说过",
                    },
                ]
            },
            ensure_ascii=False,
        )

    items = asyncio.run(MemoryAI(stream, None).suggest({}, "我家猫叫糯米"))
    assert len(items) == 1 and items[0]["content"] == "我的猫叫糯米"


def test_semantic_selection_handles_paraphrases_and_rejects_invented_ids():
    seen = []

    async def stream(config, messages, resolver):
        assert messages[0]["content"] == SELECT_SYSTEM
        seen.append(json.loads(messages[1]["content"]))
        yield '```json\n{"ids":["cat", "invented", "cat"]}\n```'

    entries = [{"id": "cat", "title": "糯米", "content": "我家猫叫糯米", "category": "fact"}]
    assert asyncio.run(MemoryAI(stream, None).select({}, "毛孩子叫什么名字？", entries)) == ["cat"]
    assert seen[0]["query"] == "毛孩子叫什么名字？"


def test_candidates_are_pending_not_retrievable_until_confirmed(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    item = {"title": "猫", "content": "猫叫糯米", "category": "fact", "evidence": "猫叫糯米"}
    store.propose("s", "t", [item])
    assert store.snapshot()["entries"] == [] and store.retrieve("猫")[1] == []
    candidate = store.candidates("s")[0]
    store.accept({"id": candidate["id"], "content": "猫叫糯米，三岁"})
    assert store.candidates() == []
    assert store.snapshot()["entries"][0]["content"] == "猫叫糯米，三岁"
    reopened = MemoryStore(store.path)
    assert reopened.snapshot()["entries"][0]["content"] == "猫叫糯米，三岁"
    other = MemoryStore(tmp_path / "another.db")
    assert other.candidates() == [] and other.snapshot()["entries"] == []


def test_dismiss_clear_and_session_deletion_prevent_resurfacing(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    item = {"title": "猫", "content": "猫叫糯米", "category": "fact", "evidence": "猫叫糯米"}
    store.propose("s", "t", [item])
    store.dismiss(store.candidates()[0]["id"])
    with store.connect() as db:
        dismissed = db.execute(
            "SELECT content,evidence,fingerprint FROM memory_candidates"
        ).fetchone()
        assert dismissed[0] == dismissed[1] == "" and dismissed[2]
    store.propose("s", "new", [item])
    assert store.candidates() == []
    store.propose("other", "t", [{**item, "content": "另一只猫"}])
    store.discard_session("other")
    assert store.candidates() == []
    store.propose("s", "t", [{**item, "content": "偏好简洁"}])
    store.clear()
    assert store.candidates() == [] and store.snapshot()["entries"] == []


class FakeAI:
    def __init__(self):
        self.queries, self.inputs = [], []

    async def select(self, config, query, entries):
        self.queries.append(query)
        return [e["id"] for e in entries if "糯米" in e["content"]]

    async def suggest(self, config, text):
        self.inputs.append(text)
        return (
            [
                {
                    "title": "猫名字",
                    "content": "我家猫叫糯米",
                    "category": "fact",
                    "evidence": "我家猫叫糯米",
                }
            ]
            if "我家猫叫糯米" in text
            else []
        )


def harness(tmp_path, ai):
    done, suggested, seen = threading.Event(), threading.Event(), []

    async def stream(config, messages, resolver):
        seen.append(messages)
        yield "回答"

    def emit(kind, payload):
        if kind == "chat.changed" and payload["status"] in {"complete", "error"}:
            done.set()
        if kind == "memory.changed":
            suggested.set()

    service = ChatService(tmp_path / "chat.db", emit, stream=stream, memory_ai=ai)
    session = service.store.new()["id"]

    def say(text, **extra):
        done.clear()
        service.send(
            {"session_id": session, "request_id": uuid.uuid4().hex, "text": text, **extra}, model()
        )
        assert done.wait(3)

    return service, session, say, suggested, seen


def test_chat_candidate_confirmation_semantic_recall_and_undo(tmp_path):
    ai = FakeAI()
    service, session, say, proposed, seen = harness(tmp_path, ai)
    try:
        say("我家猫叫糯米", context="PRIVATE_ATTACHMENT 记住：网站私密文字")
        assert proposed.wait(3)
        assert service.memory.snapshot()["entries"] == []
        assert ai.inputs == ["我家猫叫糯米"]
        candidate = service.memory.candidates(session)[0]
        service.accept_memory({"id": candidate["id"]})
        say("毛孩子叫什么名字？")
        assert "我家猫叫糯米" in seen[-1][0]["content"]
        assert service.snapshot()["memory_mode"] == "semantic"
        assert service.snapshot()["memory_refs"][0]["kind"] == "used"
        before = len(ai.queries)
        say("毛孩子叫什么名字？", use_memory=False)
        assert len(ai.queries) == before and "我家猫叫糯米" not in seen[-1][0]["content"]
        say("忘掉刚才那条")
        assert service.memory.snapshot()["entries"] == []
    finally:
        service.close()


def test_semantic_failure_falls_back_without_breaking_chat(tmp_path):
    class Broken(FakeAI):
        async def select(self, *args):
            raise ValueError("PRIVATE MODEL OUTPUT")

    service, session, say, _, seen = harness(tmp_path, Broken())
    try:
        service.memory.save({"title": "猫", "content": "猫叫糯米"})
        say("猫叫什么")
        assert service.snapshot()["status"] == "complete"
        assert service.snapshot()["memory_mode"] == "keyword_fallback"
        assert "猫叫糯米" in seen[-1][0]["content"]
        assert "PRIVATE MODEL OUTPUT" not in service.snapshot()["content"]
    finally:
        service.close()


@pytest.mark.parametrize("change", ["clear", "delete_session", "disable"])
def test_late_candidate_after_clear_is_discarded(tmp_path, change):
    entered, release = threading.Event(), threading.Event()

    class Slow(FakeAI):
        async def suggest(self, config, text):
            entered.set()
            while not release.is_set():
                await asyncio.sleep(0.01)
            return await super().suggest(config, text)

    service, session, say, _, seen = harness(tmp_path, Slow())
    try:
        say("我家猫叫糯米")
        assert entered.wait(3)
        if change == "clear":
            service.memory.clear()
        elif change == "delete_session":
            service.delete(session)
        else:
            service.memory.configure_ai({"suggestions": False, "semantic": True})
        release.set()
        service.task.result(timeout=3)
        assert service.memory.candidates() == []
        assert service.memory.snapshot()["entries"] == []
    finally:
        release.set()
        service.close()


def test_skip_and_global_disable_prevent_model_memory_calls(tmp_path):
    ai = FakeAI()
    service, session, say, _, seen = harness(tmp_path, ai)
    try:
        say("我家猫叫糯米，这件事不要记住")
        assert ai.inputs == [] and ai.queries == []
        service.memory.configure({"enabled": False, "nickname": "", "tone": "warm"})
        say("我家猫叫糯米")
        service.task.result(timeout=3)
        assert ai.inputs == [] and ai.queries == []
    finally:
        service.close()


def test_failed_batch_cancels_other_semantic_requests():
    async def exercise():
        entered, cancelled = asyncio.Event(), asyncio.Event()

        async def stream(config, messages, resolver):
            data = json.loads(messages[1]["content"])
            if data["memories"][0]["id"] == "0":
                await entered.wait()
                raise ValueError("bad batch")
            entered.set()
            try:
                await asyncio.sleep(30)
                yield '{"ids":[]}'
            finally:
                cancelled.set()

        entries = [
            {"id": str(i), "title": "t", "content": "x" * 1200, "category": "fact"}
            for i in range(10)
        ]
        with pytest.raises(ValueError):
            await MemoryAI(stream, None).select({}, "query", entries)
        assert cancelled.is_set()

    asyncio.run(exercise())


def test_semantic_batches_are_ranked_together():
    calls = []

    async def stream(config, messages, resolver):
        data = json.loads(messages[1]["content"])
        ids = [e["id"] for e in data["memories"]]
        calls.append(ids)
        yield json.dumps({"ids": ["9", "0"] if len(calls) > 2 else ids[:6]})

    entries = [
        {"id": str(i), "title": "t", "content": "x" * 1200, "category": "fact"} for i in range(10)
    ]
    assert asyncio.run(MemoryAI(stream, None).select({}, "query", entries)) == ["9", "0"]
    assert len(calls) == 3


def test_undo_uses_confirmation_order_not_old_message_position(tmp_path):
    service, session, say, proposed, seen = harness(tmp_path, FakeAI())
    try:
        say("我家猫叫糯米")
        assert proposed.wait(3)
        candidate = service.memory.candidates(session)[0]
        # Many later turns must not make a just-confirmed old suggestion un-undoable.
        for _ in range(55):
            turn = uuid.uuid4().hex
            service.store.begin(session, turn, "后来的一句话")
            service.store.update(turn, "reply", "complete")
            service.store.set_memory_refs(
                turn, [{"id": "unknown", "title": "旧引用", "kind": "used"}]
            )
        service.accept_memory({"id": candidate["id"]})
        say("忘掉刚才那条")
        assert service.memory.snapshot()["entries"] == []
    finally:
        service.close()
