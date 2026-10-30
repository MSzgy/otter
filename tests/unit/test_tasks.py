import asyncio
import json
from datetime import datetime

import pytest

from otter.companion.chat import ChatStore
from otter.companion.tasks import TaskPlanner, normalize
from otter.core.config import LLMCfg
from otter.core.llm import LLMError

NOW = datetime.fromisoformat("2026-10-17T09:00:00+08:00").timestamp() * 1000
STATE = {
    "reminders": [{"id": "r1", "title": "喝水", "dueAt": NOW + 3600000, "status": "pending"}],
    "todos": [{"id": "t1", "title": "写代码", "done": False}],
}


def norm(plan, text="请打开 https://example.com"):
    return normalize(plan, text, STATE, NOW, "Asia/Shanghai")


def test_relative_absolute_and_shift_times():
    assert (
        norm({"kind": "reminder_create", "title": "喝水", "when": {"after_seconds": 1800}})["dueAt"]
        == NOW + 1800000
    )
    assert (
        norm(
            {
                "kind": "reminder_create",
                "title": "喝水",
                "when": {"at": "2026-10-18T10:00:00+08:00"},
            }
        )["dueAt"]
        == NOW + 90000000
    )
    assert (
        norm({"kind": "reminder_update", "id": "r1", "when": {"shift_seconds": 1800}})["dueAt"]
        == NOW + 5400000
    )
    assert norm({"kind": "reminder_update", "id": "r1", "title": "开会"}) == {
        "kind": "reminder_update",
        "id": "r1",
        "title": "开会",
    }


@pytest.mark.parametrize(
    "when",
    [
        None,
        {},
        {"after_seconds": True},
        {"after_seconds": -10},
        {"after_seconds": float("nan")},
        {"after_seconds": 86400 * 367},
        {"shift_seconds": 3},
        {"at": "2026-10-18T10:00:00"},
        {"at": "2026-10-18T10:00:00+01:00"},
        {"after_seconds": 10, "at": "2026-10-18T10:00:00+08:00"},
    ],
)
def test_rejects_invalid_time(when):
    with pytest.raises((ValueError, TypeError)):
        norm({"kind": "reminder_create", "title": "喝水", "when": when})


def test_unknown_targets_operations_and_invented_urls_rejected():
    for plan in [
        {"kind": "reminder_cancel", "id": "fake"},
        {"kind": "todo_complete", "id": "r1"},
        {"kind": "shell", "target": "ls"},
        {"kind": "open_url", "target": "https://other.example.com"},
        {"kind": "reminder_update", "id": "r1"},
    ]:
        with pytest.raises(ValueError):
            norm(plan)
    assert (
        norm({"kind": "open_url", "target": "https://example.com"})["target"]
        == "https://example.com"
    )


def test_model_receives_task_context_and_returns_one_valid_plan():
    seen = []

    async def stream(config, messages, resolver):
        seen.append(json.loads(messages[1]["content"]))
        yield '```json\n{"kind":"reminder_update","id":"r1","when":{"shift_seconds":1800}}\n```'

    llm = LLMCfg(provider="openai", providers={"openai": {"model": "fixture"}})
    plan = asyncio.run(
        TaskPlanner(stream, None).plan(llm, "把它推迟半小时", STATE, [], NOW, "Asia/Shanghai")
    )
    assert plan["dueAt"] == NOW + 5400000
    assert seen[0]["now"].startswith("2026-10-17T09:00:00")
    assert seen[0]["tasks"] == STATE


def test_legacy_reminders_and_memory_do_not_call_model():
    async def unexpected(*args):
        raise AssertionError("model must not be called")
        yield ""

    llm = LLMCfg(provider="mock")
    planner = TaskPlanner(unexpected, None)
    assert (
        asyncio.run(planner.plan(llm, "3分钟后提醒我喝水", STATE, [], NOW, "Asia/Shanghai"))[
            "dueAt"
        ]
        == NOW + 180000
    )
    assert asyncio.run(
        planner.plan(llm, "记住：我喜欢简洁回答", STATE, [], NOW, "Asia/Shanghai")
    ) == {"kind": "none"}


def test_invalid_response_is_explicit_failure_not_fake_success():
    async def stream(*args):
        yield "已经帮你设置好了！"

    llm = LLMCfg(provider="openai", providers={"openai": {"model": "fixture"}})
    with pytest.raises(LLMError, match="尚未执行"):
        asyncio.run(
            TaskPlanner(stream, None).plan(llm, "帮我提醒", STATE, [], NOW, "Asia/Shanghai")
        )


def test_local_receipts_are_atomic_persistent_and_idempotent(tmp_path):
    store = ChatStore(tmp_path / "chat.db")
    session = store.new()["id"]
    store.record_action(session, "task1", "帮我添加待办", "已添加待办：检查机器人")
    store.record_action(session, "task1", "帮我添加待办", "已添加待办：检查机器人")
    assert len(store.history(session)) == 2
    reopened = ChatStore(store.path)
    assert reopened.history(session)[-1]["status"] == "complete"
    with pytest.raises(LLMError, match="冲突"):
        store.record_action(session, "task1", "不应重复", "另一个结果")
    store.delete(session)
    with pytest.raises(LLMError):
        store.record_action(session, "task2", "已删除的对话", "结果")


def test_runtime_planner_omits_attached_turns_and_private_sources(tmp_path):
    from otter.core.config import Config
    from otter.runtime.server import Runtime

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
            captured.append(history)
            return {"kind": "none"}

    runtime.task_planner = Planner()
    try:
        session = runtime.chat.store.new()["id"]
        runtime.chat.store.begin(session, "attached", "PRIVATE_REQUEST", "PRIVATE_WINDOW")
        runtime.chat.store.update("attached", "PRIVATE_SUMMARY", "complete")
        runtime.chat.store.record_action(session, "receipt", "提醒我喝水", "已创建提醒：喝水")
        runtime.dispatch(
            "tasks.plan", {"session_id": session, "text": "把它推迟半小时", "state": STATE}
        )
        contents = json.dumps(captured, ensure_ascii=False)
        assert "PRIVATE" not in contents
        assert "喝水" in contents
    finally:
        runtime.close()


SETTINGS = [
    {"id": "quiet", "label": "安静模式", "type": "switch", "current": False},
    {
        "id": "theme",
        "label": "主题",
        "type": "choice",
        "options": [
            {"value": "warm", "label": "暖阳小窝"},
            {"value": "night", "label": "夜里小窝"},
        ],
        "current": "warm",
    },
    {"id": "ambient.dailyLimit", "label": "陪伴每天最多", "type": "number", "min": 1, "max": 30},
    {"id": "memory.nickname", "label": "称呼", "type": "text", "max": 40},
]


def snorm(plan):
    return normalize(plan, "改设置", {**STATE, "settings": SETTINGS}, NOW, "Asia/Shanghai")


def test_setting_changes_take_only_offered_settings_and_values():
    assert snorm({"kind": "setting_change", "id": "quiet", "value": True}) == {
        "kind": "setting_change",
        "id": "quiet",
        "value": True,
    }
    assert snorm({"kind": "setting_change", "id": "theme", "value": "night"})["value"] == "night"
    assert snorm({"kind": "setting_change", "id": "ambient.dailyLimit", "value": 8})["value"] == 8
    assert snorm({"kind": "setting_change", "id": "memory.nickname", "value": " 小杨 "})[
        "value"
    ] == ("小杨")
    assert snorm({"kind": "setting_query"}) == {"kind": "setting_query"}
    assert snorm({"kind": "setting_query", "id": "theme"}) == {
        "kind": "setting_query",
        "id": "theme",
    }


@pytest.mark.parametrize(
    "plan",
    [
        {"kind": "setting_change", "id": "models.base_url", "value": "http://evil"},
        {"kind": "setting_change", "id": "handoff.enabled", "value": True},
        {"kind": "setting_change", "id": "quiet", "value": "true"},
        {"kind": "setting_change", "id": "quiet", "value": 1},
        {"kind": "setting_change", "id": "theme", "value": "neon"},
        {"kind": "setting_change", "id": "ambient.dailyLimit", "value": 31},
        {"kind": "setting_change", "id": "ambient.dailyLimit", "value": True},
        {"kind": "setting_change", "id": "ambient.dailyLimit", "value": 2.5},
        {"kind": "setting_change", "id": "memory.nickname", "value": "x" * 41},
        {"kind": "setting_query", "id": "models.api_key"},
    ],
)
def test_setting_changes_outside_the_list_or_range_are_rejected(plan):
    with pytest.raises(ValueError):
        snorm(plan)


def test_rejected_setting_change_asks_instead_of_guessing():
    async def stream(config, messages, resolver):
        yield json.dumps({"kind": "setting_change", "id": "models.api_key", "value": "x"})

    llm = LLMCfg(provider="openai", providers={"openai": {"model": "fixture"}})
    result = asyncio.run(
        TaskPlanner(stream, None).plan(
            llm, "把密钥改成 x", {**STATE, "settings": SETTINGS}, [], NOW, "Asia/Shanghai"
        )
    )
    assert result["kind"] == "clarify"
    assert "设置里手动改" in result["message"]


def test_mcp_config_must_come_from_the_request_word_for_word():
    text = "帮我接上 MCP：npx -y @modelcontextprotocol/server-filesystem /Users/me/Docs"
    good = {
        "mcpServers": {
            "files": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Docs"],
            }
        }
    }
    assert normalize({"kind": "mcp_add", "config": good}, text, STATE, NOW, "Asia/Shanghai") == {
        "kind": "mcp_add",
        "config": good,
    }
    invented = {"mcpServers": {"files": {"command": "npx", "args": ["-y", "evil-package"]}}}
    with pytest.raises(ValueError):
        normalize({"kind": "mcp_add", "config": invented}, text, STATE, NOW, "Asia/Shanghai")
    url = "接上这个 MCP https://mcp.example.com/mcp"
    remote = {"mcpServers": {"cloud": {"url": "https://mcp.example.com/mcp"}}}
    assert normalize({"kind": "mcp_add", "config": remote}, url, STATE, NOW, "Asia/Shanghai")
    token = {"cloud": {"url": "https://mcp.example.com/mcp", "headers": {"Authorization": "x"}}}
    with pytest.raises(ValueError):
        normalize({"kind": "mcp_add", "config": token}, url, STATE, NOW, "Asia/Shanghai")


def test_pasted_mcp_config_is_understood_without_the_model():
    async def stream(config, messages, resolver):
        raise AssertionError("no model call")
        yield ""

    llm = LLMCfg(provider="openai", providers={"openai": {"model": "fixture"}})
    config = '{"mcpServers": {"notes": {"command": "node", "args": ["s.js"]}}}'
    plan = asyncio.run(
        TaskPlanner(stream, None).plan(
            llm, "帮我添加这个：" + config, STATE, [], NOW, "Asia/Shanghai"
        )
    )
    assert plan == {"kind": "mcp_add", "config": json.loads(config)}
    one = '帮我接上 MCP {"url": "https://a.example/mcp"}'
    plan = asyncio.run(TaskPlanner(stream, None).plan(llm, one, STATE, [], NOW, "Asia/Shanghai"))
    assert plan["kind"] == "mcp_add"


def test_named_but_unspecified_mcp_server_asks_for_the_config():
    async def stream(config, messages, resolver):
        yield json.dumps(
            {"kind": "mcp_add", "config": {"files": {"command": "npx", "args": ["-y", "x"]}}}
        )

    llm = LLMCfg(provider="openai", providers={"openai": {"model": "fixture"}})
    plan = asyncio.run(
        TaskPlanner(stream, None).plan(llm, "帮我接上文件系统 MCP", STATE, [], NOW, "Asia/Shanghai")
    )
    assert plan["kind"] == "clarify"
    assert "原样发给我" in plan["message"]


def test_pasted_configs_from_other_apps_are_recognised():
    from otter.companion.tasks import _pasted_config

    vscode = '帮我添加这个 MCP {"servers": {"n": {"type": "http", "url": "https://a.example/mcp"}}}'
    gemini = '接上 mcp：{"httpUrl": "https://a.example/mcp"}'
    assert _pasted_config(vscode)["servers"]["n"]["url"] == "https://a.example/mcp"
    assert _pasted_config(gemini) == {"httpUrl": "https://a.example/mcp"}
    assert _pasted_config('看看这段 JSON {"servers": 1}') is None, "Needs the word MCP"


def test_ssh_logins_come_from_the_request_and_never_carry_a_password():
    text = "保存服务器 prod：deploy@10.0.0.5 端口 2222，密钥 ~/.ssh/prod_key，密码：••••"
    plan = snorm_text(
        {
            "kind": "ssh_save",
            "server": {
                "name": "prod",
                "host": "10.0.0.5",
                "user": "deploy",
                "port": 2222,
                "auth": "password",
                "key_path": "~/.ssh/prod_key",
            },
        },
        text,
    )
    assert plan["server"] == {
        "host": "10.0.0.5",
        "user": "deploy",
        "key_path": "~/.ssh/prod_key",
        "port": 2222,
        "auth": "password",
        "name": "prod",
    }
    for server in (
        {"host": "10.0.0.6", "user": "deploy"},
        {"host": "10.0.0.5", "user": "root"},
        {"host": "10.0.0.5", "user": "deploy", "port": 2200},
        {"host": "10.0.0.5", "user": "deploy", "jump": "ops@bastion"},
        {"host": "10.0.0.5", "user": "deploy", "auth": "telnet"},
        {"host": "0.0.5", "user": "deploy"},
    ):
        with pytest.raises(ValueError):
            snorm_text({"kind": "ssh_save", "server": server}, text)


def snorm_text(plan, text):
    return normalize(plan, text, STATE, NOW, "Asia/Shanghai")
