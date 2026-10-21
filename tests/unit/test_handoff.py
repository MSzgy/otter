import io
import json
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

from otter.companion.projects import HANDOFF_TTL, MAX_HANDOFFS, ProjectStore
from otter.core.llm import LLMError
from otter.handoff import mcp_server
from otter.handoff.mcp_server import PROTOCOLS, Server


def wait_for(predicate, timeout=3):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class FakeBroker:
    """Stands in for the desktop broker on a short Unix socket path."""

    def __init__(self, respond):
        self.dir = tempfile.mkdtemp(dir="/tmp")
        self.path = Path(self.dir) / "h.sock"
        self.respond, self.requests = respond, []
        self.hung_up = threading.Event()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(str(self.path))
        self.sock.listen()
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                data = b""
                while b"\n" not in data:
                    data += conn.recv(65536)
                request = json.loads(data)
                self.requests.append(request)
                reply = self.respond(request)
                if reply is None:
                    while conn.recv(1024):
                        pass
                    self.hung_up.set()
                else:
                    conn.sendall((json.dumps({"id": request["id"], **reply}) + "\n").encode())

    def close(self):
        self.sock.close()


class Client:
    def __init__(self):
        self.out = io.StringIO()
        self.server = Server(self.out)

    def send(self, method, params=None, msg_id=1):
        message = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if msg_id is not None:
            message["id"] = msg_id
        self.server.handle(message)

    def messages(self):
        return [json.loads(line) for line in self.out.getvalue().splitlines()]

    def response(self, msg_id):
        assert wait_for(lambda: any(m.get("id") == msg_id for m in self.messages()))
        return next(m for m in self.messages() if m.get("id") == msg_id)


@pytest.fixture
def broker(monkeypatch):
    brokers = []

    def start(respond):
        fake = FakeBroker(respond)
        monkeypatch.setenv("OTTER_HANDOFF_SOCKET", str(fake.path))
        brokers.append(fake)
        return fake

    yield start
    for fake in brokers:
        fake.close()


def test_handshake_negotiates_versions_and_lists_tools():
    client = Client()
    client.send(
        "initialize",
        {"protocolVersion": "2025-03-26", "clientInfo": {"name": "claude-code\n", "version": "2"}},
    )
    result = client.response(1)["result"]
    assert result["protocolVersion"] == "2025-03-26"
    assert result["capabilities"] == {"tools": {"listChanged": False}}
    assert client.server.client == {"name": "claude-code", "version": "2"}
    client.send("initialize", {"protocolVersion": "2099-01-01"}, msg_id=2)
    assert client.response(2)["result"]["protocolVersion"] == "2099-01-01"
    client.send("initialize", {"protocolVersion": "2020-01-01"}, msg_id=3)
    assert client.response(3)["result"]["protocolVersion"] == PROTOCOLS[0]
    client.send("notifications/initialized", msg_id=None)
    client.send("ping", msg_id=4)
    assert client.response(4)["result"] == {}
    client.send("tools/list", msg_id=5)
    tools = client.response(5)["result"]["tools"]
    assert [t["name"] for t in tools] == ["get_project_context", "propose_progress"]
    assert tools[0]["annotations"]["readOnlyHint"] is True
    client.send("resources/list", msg_id=6)
    assert client.response(6)["error"]["code"] == -32601
    client.send("tools/call", {"name": "delete_everything"}, msg_id=7)
    assert client.response(7)["error"]["code"] == -32602
    assert len(client.messages()) == 7


def test_calls_relay_to_broker_and_surface_refusals(broker):
    fake = broker(
        lambda r: {"result": {"text": "# 桌面机器人"}}
        if r["method"] == "context"
        else {"error": "用户拒绝了这次读取。"}
    )
    client = Client()
    client.send("initialize", {"clientInfo": {"name": "codex"}})
    client.send(
        "tools/call",
        {"name": "get_project_context", "arguments": {"project": "桌面机器人"}},
        msg_id=2,
    )
    assert client.response(2)["result"] == {
        "content": [{"type": "text", "text": "# 桌面机器人"}],
        "isError": False,
    }
    assert fake.requests[0]["method"] == "context"
    assert fake.requests[0]["client"]["name"] == "codex"
    assert fake.requests[0]["params"] == {"project": "桌面机器人"}
    client.send(
        "tools/call", {"name": "propose_progress", "arguments": {"next": ["接屏幕"]}}, msg_id=3
    )
    refused = client.response(3)["result"]
    assert refused["isError"] is True and "拒绝" in refused["content"][0]["text"]


def test_missing_app_is_a_tool_error_not_a_crash(monkeypatch):
    monkeypatch.setenv("OTTER_HANDOFF_SOCKET", "/tmp/otter-missing-" + str(time.time()))
    client = Client()
    client.send("tools/call", {"name": "get_project_context", "arguments": {}})
    result = client.response(1)["result"]
    assert result["isError"] is True and "没有运行" in result["content"][0]["text"]


def test_cancel_withdraws_pending_request_without_reply(broker):
    fake = broker(lambda _r: None)
    client = Client()
    client.send("tools/call", {"name": "get_project_context", "arguments": {}}, msg_id="a")
    assert wait_for(lambda: fake.requests)
    client.send("notifications/cancelled", {"requestId": "a"}, msg_id=None)
    assert fake.hung_up.wait(3)
    time.sleep(0.1)
    assert client.messages() == []


def test_stdio_loop_rejects_bad_json_and_exits_on_eof():
    out = io.StringIO()
    mcp_server.main(io.StringIO('not json\n\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n'), out)
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert lines[0]["error"]["code"] == -32700
    assert lines[1] == {"jsonrpc": "2.0", "id": 9, "result": {}}


def test_handoff_inbox_reviews_before_saving(tmp_path):
    store = ProjectStore(tmp_path / "projects.db")
    project = store.save({"name": "桌面机器人", "goal": "做一只会动的水獭"})
    with pytest.raises(LLMError, match="1–15"):
        store.handoff_add({"client": "Codex"})
    with pytest.raises(LLMError):
        store.handoff_add({"client": "Codex", "next": ["x" * 201]})
    with pytest.raises(LLMError, match="格式"):
        store.handoff_add({"client": "Codex", "next": "接屏幕"})
    added = store.handoff_add(
        {
            "client": "Codex",
            "project": "桌面机器人",
            "completed": ["舵机接好"],
            "next": ["接屏幕"],
            "note": "分支 feat/servo",
        }
    )
    assert added["project"] == "桌面机器人"
    [inbox] = store.handoff_list()
    assert inbox["project_id"] == project["id"] and inbox["client"] == "Codex"
    draft = store.handoff_open(inbox["id"], project["id"])
    [source] = draft["sources"]
    assert source["role"] == "agent" and "自述" in source["label"]
    assert "分支 feat/servo" in source["content"]
    assert all(i["evidence"] == [] for i in draft["items"])
    assert store.get(project["id"])["snapshots"] == []
    saved = store.commit({"draft_id": draft["id"], "items": draft["items"]})
    items = saved["snapshots"][0]["items"]
    assert [i["content"] for i in items] == ["舵机接好", "接屏幕"]
    assert not any(i["edited"] for i in items)
    assert store.handoff_list() == []
    with pytest.raises(LLMError, match="已处理"):
        store.handoff_open(inbox["id"], project["id"])


def test_handoff_inbox_matching_expiry_dismiss_and_cap(tmp_path):
    store = ProjectStore(tmp_path / "projects.db")
    project = store.save({"name": "Robot", "goal": ""})
    assert store.handoff_add({"client": "Claude", "project": "robot", "next": ["a"]})["project"]
    store.archive(project["id"], True)
    assert store.handoff_list()[0]["project_id"] is None
    old = store.handoff_add({"client": "Claude", "next": ["old"]})
    with store.connect() as db:
        db.execute(
            "UPDATE handoffs SET created=? WHERE id=?", (time.time() - HANDOFF_TTL - 1, old["id"])
        )
    assert [h["items"][0]["content"] for h in store.handoff_list()] == ["a"]
    store.handoff_dismiss(store.handoff_list()[0]["id"])
    assert store.handoff_list() == []
    for i in range(MAX_HANDOFFS):
        store.handoff_add({"client": "Claude", "next": [f"n{i}"]})
    with pytest.raises(LLMError, match="待检查"):
        store.handoff_add({"client": "Claude", "next": ["overflow"]})


def test_runtime_routes_handoff_inbox(tmp_path, monkeypatch):
    from otter.core.config import Config
    from otter.core.paths import _reset_cache_for_tests
    from otter.runtime.server import Runtime

    monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
    _reset_cache_for_tests()
    config = Config.model_validate(
        {
            "core": {"timezone": "Asia/Shanghai"},
            "identity": {"primary": "t@example.com"},
            "llm": {"provider": "mock"},
        }
    )
    runtime = Runtime(config, lambda *_: None)
    try:
        project = runtime.dispatch("projects.save", {"name": "桌面机器人", "goal": ""})
        runtime.dispatch(
            "projects.handoff-add", {"client": "Codex", "project": "桌面机器人", "next": ["接屏幕"]}
        )
        [item] = runtime.dispatch("projects.handoff-list", {})
        runtime.chat.turn = {"id": "t", "session_id": "s", "status": "streaming"}
        with pytest.raises(Exception, match="停止当前回复"):
            runtime.dispatch(
                "projects.handoff-open", {"handoff_id": item["id"], "project_id": project["id"]}
            )
        runtime.chat.turn = None
        draft = runtime.dispatch(
            "projects.handoff-open", {"handoff_id": item["id"], "project_id": project["id"]}
        )
        assert draft["items"][0]["content"] == "接屏幕"
        runtime.dispatch("projects.handoff-dismiss", {"handoff_id": item["id"]})
        assert runtime.dispatch("projects.handoff-list", {}) == []
    finally:
        runtime.close()
        _reset_cache_for_tests()
