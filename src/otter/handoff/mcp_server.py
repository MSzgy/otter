"""Minimal MCP stdio server that relays tool calls to the running Otter desktop app.

Agents never touch Otter's databases. Every call goes to the desktop broker over a
user-only Unix socket; reads wait there for the user's approval. Standard library
only, so it starts quickly from the bundled runtime.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import socket
import sys
import threading
import uuid
from pathlib import Path

SERVER_INFO = {"name": "otter", "title": "Otter", "version": "0.12.0"}
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
# The broker gives the user 45 s to approve; Codex's default tool timeout is 60 s.
READ_TIMEOUT = 55
WRITE_TIMEOUT = 15
MAX_LINE = 512 * 1024
INSTRUCTIONS = (
    "Otter 是用户 Mac 上的桌面助手，保存用户亲自确认过的项目进度。"
    "需要了解用户项目的目标、已完成事项、卡点和下一步时，调用 get_project_context；"
    "用户会在 Otter 里看到完整预览并决定是否发送。"
    "一段工作结束时，可以调用 propose_progress 把本次进度交给 Otter，用户确认后才会保存。"
    "Otter is the user's desktop companion holding user-confirmed project progress. "
    "Reads need the user's approval in Otter; proposals are saved only after the user reviews them."
)
_ITEMS = {"type": "array", "items": {"type": "string", "maxLength": 600}, "maxItems": 15}
TOOLS = [
    {
        "name": "get_project_context",
        "title": "读取 Otter 项目进度",
        "description": (
            "Ask the user's Otter desktop app for a project's confirmed progress: goal, "
            "latest snapshot (completed / blockers / next steps), open project todos and "
            "saved links. The user previews exactly what will be sent and approves or "
            "declines in Otter; this may wait up to 45 seconds. Omit `project` to let the "
            "user pick. 向 Otter 请求读取用户确认过的项目进度，需要用户在 Otter 中批准。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "maxLength": 80,
                    "description": "Project name as the user calls it, e.g. 桌面机器人.",
                },
                "reason": {
                    "type": "string",
                    "maxLength": 300,
                    "description": "One sentence shown to the user explaining why you need it.",
                },
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "propose_progress",
        "title": "把进度交给 Otter",
        "description": (
            "Hand this session's progress to Otter so the next tool (or the user) can pick "
            "it up. Nothing is saved until the user reviews and confirms it in Otter. Give "
            "short, concrete items. 把本次会话的进度交给 Otter，用户检查确认后才保存为项目快照。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "maxLength": 80},
                "completed": {**_ITEMS, "description": "What got done."},
                "blockers": {**_ITEMS, "description": "What is blocking or unresolved."},
                "next": {
                    **_ITEMS,
                    "items": {"type": "string", "maxLength": 200},
                    "description": "Concrete next steps.",
                },
                "note": {
                    "type": "string",
                    "maxLength": 2000,
                    "description": "Optional context for the user, e.g. branch or files touched.",
                },
            },
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": False,
            "openWorldHint": False,
        },
    },
]
METHODS = {
    "get_project_context": ("context", READ_TIMEOUT),
    "propose_progress": ("propose", WRITE_TIMEOUT),
}


class BrokerError(Exception):
    pass


def socket_path() -> Path:
    configured = os.environ.get("OTTER_HANDOFF_SOCKET")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "Library/Application Support/otter-desktop/handoff.sock"


def relay(method, client, arguments, timeout, register=lambda _conn: None):
    request = {"id": uuid.uuid4().hex, "method": method, "client": client, "params": arguments}
    buffer = b""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            register(conn)
            conn.settimeout(timeout)
            conn.connect(str(socket_path()))
            conn.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode())
            while b"\n" not in buffer:
                chunk = conn.recv(65536)
                if not chunk:
                    raise BrokerError("Otter 中断了连接，请重试。(Otter closed the connection.)")
                buffer += chunk
                if len(buffer) > MAX_LINE:
                    raise BrokerError("Otter 返回的数据过大。(Response too large.)")
    except (FileNotFoundError, ConnectionRefusedError):
        raise BrokerError(
            "Otter 没有运行，或没有在“AI 交接”页开启交接。请让用户打开 Otter 并开启。"
            "(Otter is not running or AI handoff is turned off.)"
        ) from None
    except TimeoutError:
        raise BrokerError("等待 Otter 响应超时。(Timed out waiting for Otter.)") from None
    except OSError:
        raise BrokerError("无法连接 Otter。(Could not reach Otter.)") from None
    try:
        response = json.loads(buffer.split(b"\n", 1)[0])
    except ValueError:
        raise BrokerError("Otter 返回格式无效。(Invalid response from Otter.)") from None
    if response.get("error"):
        raise BrokerError(str(response["error"])[:2000])
    result = response.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("text"), str):
        raise BrokerError("Otter 返回格式无效。(Invalid response from Otter.)")
    return result["text"]


def _clean(value, limit):
    return re.sub(r"[\x00-\x1f\x7f]", "", value)[:limit] if isinstance(value, str) else ""


class Server:
    def __init__(self, stdout):
        self.stdout = stdout
        self.output = threading.Lock()
        self.client = {"name": "", "version": ""}
        self.calls = {}
        self.cancelled = set()
        self.calls_lock = threading.Lock()

    def write(self, message):
        with self.output:
            self.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
            self.stdout.flush()

    def reply(self, msg_id, result=None, error=None):
        message = {"jsonrpc": "2.0", "id": msg_id}
        message.update({"error": error} if error else {"result": result})
        self.write(message)

    def handle(self, message):
        if not isinstance(message, dict):
            self.reply(None, error={"code": -32600, "message": "Invalid request"})
            return
        method, msg_id = message.get("method"), message.get("id")
        params = message.get("params") or {}
        if "id" not in message:
            if method == "notifications/cancelled" and isinstance(params, dict):
                self.cancel(params.get("requestId"))
            return
        if method == "initialize":
            info = params.get("clientInfo") if isinstance(params, dict) else None
            info = info if isinstance(info, dict) else {}
            self.client = {
                "name": _clean(info.get("title") or info.get("name"), 80),
                "version": _clean(info.get("version"), 40),
            }
            requested = params.get("protocolVersion") if isinstance(params, dict) else None
            # Tools-only servers behave the same across revisions, so accept newer ones.
            newer = isinstance(requested, str) and bool(
                re.fullmatch(r"\d{4}-\d{2}-\d{2}", requested)
            )
            if requested not in PROTOCOLS and not (newer and requested > PROTOCOLS[0]):
                requested = PROTOCOLS[0]
            self.reply(
                msg_id,
                {
                    "protocolVersion": requested,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": SERVER_INFO,
                    "instructions": INSTRUCTIONS,
                },
            )
        elif method == "ping":
            self.reply(msg_id, {})
        elif method == "tools/list":
            self.reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            if not isinstance(params, dict):
                params = {}
            name, arguments = params.get("name"), params.get("arguments") or {}
            if name not in METHODS or not isinstance(arguments, dict):
                self.reply(msg_id, error={"code": -32602, "message": f"Unknown tool: {name}"})
                return
            # Approval can take a while; keep answering pings and cancellations meanwhile.
            threading.Thread(
                target=self.call, args=(msg_id, name, arguments), daemon=True
            ).start()
        else:
            self.reply(msg_id, error={"code": -32601, "message": f"Method not found: {method}"})

    def call(self, msg_id, name, arguments):
        method, timeout = METHODS[name]
        key = json.dumps(msg_id)

        def register(conn):
            with self.calls_lock:
                self.calls[key] = conn

        try:
            text = relay(method, self.client, arguments, timeout, register)
            result = {"content": [{"type": "text", "text": text}], "isError": False}
        except BrokerError as exc:
            result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
        with self.calls_lock:
            self.calls.pop(key, None)
            cancelled = key in self.cancelled
            self.cancelled.discard(key)
        # Cancelled requests get no response, per the MCP cancellation rules.
        if not cancelled:
            self.reply(msg_id, result)

    def cancel(self, request_id):
        key = json.dumps(request_id)
        with self.calls_lock:
            conn = self.calls.get(key)
            if conn:
                self.cancelled.add(key)
        if conn:
            # Closing the socket tells the broker to withdraw the approval card.
            with contextlib.suppress(OSError):
                conn.shutdown(socket.SHUT_RDWR)


def main(stdin=None, stdout=None):
    if stdin is None:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    server = Server(stdout)
    while True:
        line = stdin.readline(MAX_LINE + 1)
        if not line:
            break
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except ValueError:
            server.reply(None, error={"code": -32700, "message": "Parse error"})
            continue
        server.handle(message)
    # The client hung up: withdraw pending approval cards instead of waiting on them.
    with server.calls_lock:
        pending = list(server.calls)
    for key in pending:
        server.cancel(json.loads(key))


if __name__ == "__main__":
    main()
