import asyncio
import json
import threading
import uuid

import pytest

from otter.companion.chat import ChatService
from otter.companion.project_ai import ProjectAI
from otter.companion.projects import ProjectStore
from otter.companion.tasks import normalize
from otter.core.config import Config, LLMCfg
from otter.core.llm import LLMError
from otter.runtime.server import RequestError, Runtime


def save_snapshot(store, project_id, content="完成连接测试", kind="completed"):
    draft = store.draft(project_id, [], [])
    return store.commit(
        {"draft_id": draft["id"], "items": [{"kind": kind, "content": content, "source_ids": []}]}
    )


def test_projects_snapshots_bindings_persist_and_are_workspace_scoped(tmp_path):
    store = ProjectStore(tmp_path / "projects.db")
    one = store.save({"name": "水獭", "goal": "做桌面机器人"})
    two = store.save({"name": "网站", "goal": "改首页"})
    save_snapshot(store, one["id"])
    save_snapshot(store, two["id"], "网站内容", "next")
    store.bind("chat", one["id"])
    reopened = ProjectStore(store.path)
    assert "完成连接测试" in reopened.prompt("chat")
    assert "网站内容" not in reopened.prompt("chat")
    assert reopened.prompt("another-chat") == ""
    assert ProjectStore(tmp_path / "another.db").list() == []
    store.archive(one["id"], True)
    assert store.binding("chat") is None
    assert store.get(one["id"])["snapshots"]
    with pytest.raises(LLMError):
        store.bind("chat", one["id"])
    store.archive(one["id"], False)
    assert not store.get(one["id"])["archived"]


def test_unconfirmed_and_stale_drafts_do_not_enter_context(tmp_path):
    store = ProjectStore(tmp_path / "projects.db")
    project = store.save({"name": "水獭"})
    store.bind("s", project["id"])
    draft = store.draft(
        project["id"], [{"kind": "next", "content": "尚未确认的计划", "source_ids": []}], []
    )
    assert "尚未确认" not in store.prompt("s")
    store.save({**project, "goal": "新的目标"})
    with pytest.raises(LLMError, match="项目已更新"):
        store.commit({"draft_id": draft["id"], "items": draft["items"]})
    assert store.get(project["id"])["snapshots"] == []
    fresh = store.draft(
        project["id"], [{"kind": "next", "content": "新计划", "source_ids": []}], []
    )
    store.invalidate()
    with pytest.raises(LLMError, match="过期"):
        store.commit({"draft_id": fresh["id"], "items": fresh["items"]})


def test_sources_and_edited_evidence_are_kept_honestly(tmp_path):
    store = ProjectStore(tmp_path / "projects.db")
    project = store.save({"name": "水獭"})
    source = {"id": "s1", "content": "先测试串口", "label": "你说的", "created": 1}
    original = {
        "kind": "next",
        "content": "测试串口",
        "source_ids": ["s1"],
        "evidence": [{"source_id": "s1", "quote": "测试串口"}],
    }
    draft = store.draft(project["id"], [original], [source])
    changed = {**draft["items"][0], "content": "先测试供电"}
    saved = store.commit({"draft_id": draft["id"], "items": [changed]})
    item = saved["snapshots"][0]["items"][0]
    assert item["edited"] and not item["evidence"]
    assert saved["snapshots"][0]["sources"][0] == source
    store.forget_session("s")
    assert store.get(project["id"])["snapshots"]
    with pytest.raises(LLMError):
        store.commit({"draft_id": draft["id"], "items": [changed]})


def test_links_are_validated_and_keep_stable_ids(tmp_path):
    store = ProjectStore(tmp_path / "projects.db")
    for url in ["file:///tmp/a", "javascript:alert(1)", "https://user:pass@example.com"]:
        with pytest.raises(LLMError):
            store.save({"name": "bad", "links": [{"label": "资料", "url": url}]})
    one = store.save(
        {"name": "水獭", "links": [{"label": "文档", "url": "https://example.com/project"}]}
    )
    two = store.save({**one, "goal": "新目标"})
    assert one["links"][0]["id"] == two["links"][0]["id"]
    with pytest.raises(LLMError):
        store.save({"name": "水獭"})
    metadata = store.metadata("s")
    assert "https://" not in json.dumps(metadata)


def test_summary_requires_real_source_evidence():
    async def stream(*args):
        yield json.dumps(
            {
                "items": [
                    {
                        "kind": "completed",
                        "content": "串口已验证",
                        "source_ids": ["s1"],
                        "evidence": [{"source_id": "s1", "quote": "串口已验证"}],
                    },
                    {
                        "kind": "completed",
                        "content": "舵机也完成",
                        "source_ids": ["s1"],
                        "evidence": [{"source_id": "s1", "quote": "不存在的原文"}],
                    },
                    {
                        "kind": "next",
                        "content": "虚假来源",
                        "source_ids": ["fake"],
                        "evidence": [{"source_id": "fake", "quote": "伪造"}],
                    },
                ]
            }
        )

    llm = LLMCfg(provider="openai", providers={"openai": {"model": "test"}})
    items = asyncio.run(
        ProjectAI(stream, None).summarize(
            llm, {"name": "水獭", "goal": ""}, [{"id": "s1", "content": "串口已验证"}]
        )
    )
    assert len(items) == 1 and items[0]["kind"] == "completed"


def test_project_intents_cannot_choose_unknown_or_unselected_projects():
    state = {
        "projects": [
            {"id": "a", "name": "水獭", "links": [{"id": "link", "label": "文档"}]},
            {"id": "b", "name": "网站", "links": []},
        ],
        "current_project": "a",
    }
    assert (
        normalize({"kind": "project_resume", "project_id": "a"}, "继续", state, 0, "Asia/Shanghai")[
            "project_id"
        ]
        == "a"
    )
    with pytest.raises(ValueError):
        normalize({"kind": "project_resume", "project_id": "b"}, "继续", state, 0, "Asia/Shanghai")
    with pytest.raises(ValueError):
        normalize(
            {"kind": "project_open", "project_id": "a", "link_id": "fake"},
            "打开资料",
            state,
            0,
            "Asia/Shanghai",
        )
    assert (
        normalize(
            {"kind": "project_resume", "project_id": "b"}, "继续网站", state, 0, "Asia/Shanghai"
        )["project_id"]
        == "b"
    )


def test_chat_uses_only_bound_confirmed_project_even_with_memory_disabled(tmp_path):
    seen, done = [], threading.Event()

    async def stream(config, messages, resolver):
        seen.append(messages)
        yield "继续这个项目"

    service = ChatService(
        tmp_path / "chat.db",
        lambda kind, value: (
            done.set() if kind == "chat.changed" and value["status"] == "complete" else None
        ),
        stream=stream,
    )
    try:
        project = service.projects.save({"name": "水獭"})
        save_snapshot(service.projects, project["id"], "专属项目下一步", "next")
        session = service.store.new()["id"]
        service.projects.bind(session, project["id"])
        service.send(
            {
                "text": "继续",
                "session_id": session,
                "request_id": uuid.uuid4().hex,
                "use_memory": False,
            },
            LLMCfg(provider="openai", providers={"openai": {"model": "test"}}),
        )
        assert done.wait(3)
        assert "专属项目下一步" in seen[0][0]["content"]
        assert service.projects.prompt("unknown") == ""
    finally:
        service.close()


def test_runtime_selects_only_explicit_sources_and_discards_late_analysis(tmp_path):
    config = Config.model_validate(
        {
            "identity": {"primary": "fixture@example.com"},
            "llm": {"provider": "mock"},
            "core": {"data_dir": str(tmp_path / "data")},
        }
    )
    runtime = Runtime(config, lambda *args: None)
    entered, release = threading.Event(), threading.Event()
    selected = []

    class AI:
        async def summarize(self, llm, project, sources):
            selected.extend(sources)
            entered.set()
            release.wait(3)
            return [{"kind": "next", "content": "下一步", "source_ids": [sources[0]["id"]]}]

    runtime.project_ai = AI()
    try:
        project = runtime.dispatch("projects.save", {"name": "测试"})
        session = runtime.chat.store.new()["id"]
        runtime.chat.store.begin(session, "turn", "选中的消息", "PRIVATE_ATTACHMENT")
        runtime.chat.store.update("turn", "助手消息", "complete")
        sources = runtime.dispatch("projects.sources", {"session_id": session})
        chosen = next(s for s in sources if s["label"] == "你说的")
        failures = []

        def draft():
            try:
                runtime.dispatch(
                    "projects.draft",
                    {
                        "project_id": project["id"],
                        "session_id": session,
                        "source_ids": [chosen["id"]],
                    },
                )
            except RequestError as e:
                failures.append(str(e))

        worker = threading.Thread(target=draft)
        worker.start()
        assert entered.wait(3)
        runtime.chat.projects.invalidate()
        release.set()
        worker.join(3)
        assert failures and "来源已变化" in failures[0]
        assert len(selected) == 1 and "PRIVATE_ATTACHMENT" not in json.dumps(selected)
        assert runtime.chat.projects.get(project["id"])["snapshots"] == []
    finally:
        release.set()
        runtime.close()


def test_task_planning_only_receives_todos_from_the_selected_project(tmp_path):
    config = Config.model_validate(
        {
            "identity": {"primary": "fixture@example.com"},
            "llm": {"provider": "mock"},
            "core": {"data_dir": str(tmp_path / "data")},
        }
    )
    runtime = Runtime(config, lambda *args: None)
    captured = []

    class Planner:
        async def plan(self, llm, text, state, history, now, timezone):
            captured.append(state)
            return {"kind": "none"}

    runtime.task_planner = Planner()
    try:
        one = runtime.chat.projects.save({"name": "甲"})
        two = runtime.chat.projects.save({"name": "乙"})
        session = runtime.chat.store.new()["id"]
        runtime.chat.projects.bind(session, one["id"])
        tasks = {
            "todos": [
                {"id": "a", "title": "甲任务", "done": False, "projectId": one["id"]},
                {"id": "b", "title": "乙任务", "done": False, "projectId": two["id"]},
                {"id": "g", "title": "通用任务", "done": False},
            ]
        }
        runtime.dispatch("tasks.plan", {"session_id": session, "text": "继续", "state": tasks})
        assert [t["id"] for t in captured[-1]["todos"]] == ["a"]
        runtime.chat.projects.bind(session, None)
        runtime.dispatch("tasks.plan", {"session_id": session, "text": "继续", "state": tasks})
        assert [t["id"] for t in captured[-1]["todos"]] == ["g"]
    finally:
        runtime.close()


def test_restore_does_not_create_ambiguous_active_project_names(tmp_path):
    store = ProjectStore(tmp_path / "projects.db")
    old = store.save({"name": "水獭"})
    store.archive(old["id"], True)
    store.save({"name": "水獭"})
    with pytest.raises(LLMError, match="同名项目"):
        store.archive(old["id"], False)
    assert store.get(old["id"])["archived"]
