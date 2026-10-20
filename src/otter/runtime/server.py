"""Bounded JSON-RPC over stdio. A single worker owns report jobs and its Store."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import json
import os
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from otter.application.model_settings import ModelSettings
from otter.application.reports import make_orchestrator, notify_report, open_store
from otter.companion.chat import ChatService, openai_stream
from otter.companion.project_ai import ProjectAI
from otter.companion.tasks import TaskPlanner
from otter.companion.voice import transcribe
from otter.core.config import Config, load
from otter.core.llm import LLMError
from otter.core.paths import _reset_cache_for_tests

MAX_LINE = 64 * 1024


class RequestError(Exception):
    pass


def valid_date(value: Any) -> str:
    if not isinstance(value, str):
        raise RequestError("请选择有效日期。")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise RequestError("日期格式应为 YYYY-MM-DD。") from None
    if parsed.strftime("%Y-%m-%d") != value:
        raise RequestError("日期格式应为 YYYY-MM-DD。")
    return value


class Runtime:
    def __init__(
        self, config: Config, emit, model_path: Path | None = None, audio_dir: Path | None = None
    ):
        self.config = config
        self.audio_dir = audio_dir
        self.emit = emit
        self.models = ModelSettings(config, model_path)
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="otter-report")
        self.jobs: dict[str, dict] = {}
        self.active: str | None = None
        # Connections are opened/closed on their owning thread, never passed to workers.
        with open_store(config):
            pass
        self.chat = ChatService(config.data_path() / "chat.sqlite3", emit)
        self.task_planner = TaskPlanner(openai_stream, self.chat.resolver)
        self.project_ai = ProjectAI(openai_stream, self.chat.resolver)
        self.chat.projects.timezone = config.core.timezone

    def dispatch(self, method: str, params: dict) -> Any:
        if method == "health.get":
            now = datetime.now(ZoneInfo(self.config.core.timezone))
            return {
                "protocol_version": 1,
                "provider": self.config.llm.provider,
                "demo": self.config.llm.provider == "mock",
                "model": self.config.llm.provider_config().get("model", ""),
                "timezone": self.config.core.timezone,
                "today": now.date().isoformat(),
                "yesterday": (now.date() - timedelta(days=1)).isoformat(),
                "collectors": [
                    name for name, cfg in self.config.collectors.items() if cfg.get("enabled", True)
                ],
            }
        if method.startswith("projects."):
            return self._projects(method, params)
        if method == "memory.candidates":
            return self.chat.memory.candidates(params.get("session_id"))
        if method == "memory.get":
            return self.chat.memory.snapshot()
        if method in {
            "memory.save",
            "memory.delete",
            "memory.clear",
            "memory.configure",
            "memory.ai-configure",
            "memory.accept",
            "memory.dismiss",
        }:
            with self.chat.lock:
                if self.chat.turn and self.chat.turn["status"] == "streaming":
                    raise LLMError("请先等待或停止当前回复，再修改记忆。")
                if method == "memory.ai-configure":
                    result = self.chat.memory.configure_ai(params)
                elif method == "memory.accept":
                    result = self.chat.accept_memory(params)
                elif method == "memory.dismiss":
                    result = self.chat.memory.dismiss(params.get("id"))
                elif method == "memory.save":
                    result = self.chat.memory.save(params)
                elif method == "memory.delete":
                    result = self.chat.memory.delete(params.get("id"))
                elif method == "memory.clear":
                    if params.get("confirm") is not True:
                        raise LLMError("请确认清空记忆。")
                    result = self.chat.memory.clear()
                else:
                    result = self.chat.memory.configure(params)
                self.chat.invalidate_memory_work()
                self.emit("memory.changed", {})
                return result
        if method == "chat.sessions":
            return self.chat.store.sessions()
        if method == "chat.new":
            return self.chat.store.new()
        if method == "chat.history":
            return self.chat.store.history(params.get("session_id"))
        if method == "chat.state":
            return self.chat.snapshot()
        if method == "tasks.plan":
            rows = self.chat.store.history(params.get("session_id"))
            excluded = {r["turn_id"] for r in rows if r.get("context")}
            history = [
                {"role": r["role"], "content": r["content"][:600]}
                for r in rows
                if r["turn_id"] not in excluded and r["status"] == "complete"
            ][-6:]
            state = params.get("state", {})
            if not isinstance(state, dict) or len(json.dumps(state)) > 45000:
                raise RequestError("办事上下文过大，请在生活助手里处理。")
            state = {**state, **self.chat.projects.metadata(params.get("session_id"))}
            state["todos"] = [
                t
                for t in state.get("todos", [])
                if (t.get("projectId") or None) == state.get("current_project")
            ]
            with self.lock:
                llm = self.config.llm.model_copy(deep=True)
            result = asyncio.run(
                self.task_planner.plan(
                    llm,
                    params.get("text"),
                    state,
                    history,
                    time.time() * 1000,
                    self.config.core.timezone,
                )
            )
            if result.get("projectId"):
                project = self.chat.projects.get(result["projectId"])
                if project["archived"]:
                    raise RequestError("项目已归档，请重新选择。")
                result["project_ref"] = {
                    "project_id": project["id"],
                    "revision": project["revision"],
                }
                result["projectName"] = project["name"]
            return result
        if method == "tasks.record":
            # Internal main-process endpoint, deliberately absent from renderer RPC allowlist.
            for key, limit in (("text", 6000), ("result", 30000), ("request_id", 80)):
                if not isinstance(params.get(key), str) or not 1 <= len(params[key]) <= limit:
                    raise RequestError("操作回执格式无效。")
            with self.chat.lock:
                if self.chat.turn and self.chat.turn["status"] == "streaming":
                    raise RequestError("请先等待当前回复完成。")
                self.chat.store.record_action(
                    params.get("session_id"), params["request_id"], params["text"], params["result"]
                )
            return {"ok": True}
        if method == "chat.send":
            with self.lock:
                return self.chat.send(params, self.config.llm)
        if method == "chat.cancel":
            return self.chat.cancel(params.get("turn_id"))
        if method == "chat.delete":
            result = self.chat.delete(params.get("session_id"))
            self.chat.projects.forget_session(params.get("session_id"))
            return result
        if method == "models.get":
            with self.lock:
                return self.models.public()
        if method in {"models.save", "models.reset"}:
            with self.lock:
                turn = self.chat.snapshot()
                if self.active or (turn and turn["status"] == "streaming"):
                    raise RequestError("请等待当前回复或简报完成后修改模型。")
                self.chat.invalidate_memory_work()
                self.chat.projects.invalidate()
                return self.models.save(params) if method == "models.save" else self.models.reset()
        if method == "voice.transcribe":
            return transcribe(self.config, self.audio_dir, params)
        if method == "models.test":
            return self.models.test(params)
        if method == "reports.list":
            with open_store(self.config) as store:
                return [
                    r.model_dump(mode="json", exclude={"content_md", "trace_path"})
                    for r in store.list_reports(limit=60)
                ]
        if method == "reports.get":
            date = valid_date(params.get("date"))
            with open_store(self.config) as store:
                report = store.get_report(date)
                return report.model_dump(mode="json", exclude={"trace_path"}) if report else None
        if method == "jobs.list":
            with self.lock:
                return [dict(j) for j in self.jobs.values()]
        if method == "reports.generate":
            date = valid_date(params.get("date"))
            collect = params.get("collect", False)
            if not isinstance(collect, bool):
                raise RequestError("collect 必须为布尔值。")
            with self.lock:
                if self.active:
                    raise RequestError("已有简报正在生成，请等待完成。")
                job_id = uuid.uuid4().hex
                job = {"id": job_id, "date": date, "status": "queued", "message": "准备生成简报"}
                self.jobs[job_id] = job
                self.active = job_id
                while len(self.jobs) > 50:
                    del self.jobs[next(iter(self.jobs))]
                self.worker.submit(self._generate, job_id, date, collect)
                return {"job_id": job_id}
        raise RequestError("不支持的操作。")

    def _project_sources(self, session_id):
        rows = self.chat.store.history(session_id)
        sources = []
        for row in rows[-30:]:
            if row["status"] != "complete":
                continue
            for suffix, content, label in (
                ("", row["content"], "你说的" if row["role"] == "user" else "水獭回复"),
                (":context", row.get("context", ""), "你附带的资料"),
            ):
                if content:
                    sources.append(
                        {
                            "id": row["id"] + suffix,
                            "message_id": row["id"],
                            "session_id": session_id,
                            "role": row["role"],
                            "label": label,
                            "attachment": bool(suffix),
                            "created": row["created"],
                            "content": content[:2000],
                            "truncated": len(content) > 2000,
                        }
                    )
        return sources

    def _projects(self, method, params):
        store = self.chat.projects
        project_id, session_id = params.get("project_id"), params.get("session_id")
        if method == "projects.list":
            return store.list()
        if method == "projects.get":
            return store.get(project_id)
        if method == "projects.sources":
            return self._project_sources(session_id)
        if method == "projects.binding":
            return store.binding(session_id)
        if method == "projects.scope":
            with store.connect() as db:
                row = db.execute(
                    "SELECT project_id FROM bindings JOIN projects ON projects.id=project_id "
                    "WHERE session_id=? AND archived=0",
                    (session_id,),
                ).fetchone()
            return row[0] if row else ""
        if method == "projects.check":
            project = store.get(project_id)
            if project["archived"] or project["revision"] != params.get("revision"):
                raise RequestError("项目已更新，请重新确认操作。")
            return {"ok": True}
        if method == "projects.resolve":
            project = store.get(project_id)
            if project["archived"]:
                raise RequestError("请先恢复已归档项目。")
            if params.get("kind") == "project_open":
                link = next(
                    (link for link in project["links"] if link["id"] == params.get("link_id")), None
                )
                if not link:
                    raise RequestError("资料链接已变化，请重新选择。")
                return {
                    "kind": "open_url",
                    "target": link["url"],
                    "project_ref": {"project_id": project_id, "revision": project["revision"]},
                }
            if params.get("kind") == "project_todo":
                snapshot = project["snapshots"][0] if project["snapshots"] else None
                item = (
                    next(
                        (
                            i
                            for i in snapshot["items"]
                            if i["kind"] == "next"
                            and (not params.get("item_id") or i["id"] == params["item_id"])
                        ),
                        None,
                    )
                    if snapshot
                    else None
                )
                if not item:
                    raise RequestError("项目尚未保存下一步，请先记录进度。")
                return {
                    "kind": "todo_add",
                    "title": item["content"][:200],
                    "projectId": project_id,
                    "projectName": project["name"],
                    "sourceKey": snapshot["id"] + ":" + item["id"],
                    "project_ref": {"project_id": project_id, "revision": project["revision"]},
                }
            raise RequestError("不支持的项目操作。")
        with self.chat.lock:
            if self.chat.turn and self.chat.turn["status"] == "streaming":
                raise RequestError("请等待或停止当前回复后再更新项目。")
            if method == "projects.bind":
                self.chat.store.history(session_id)
                return store.bind(session_id, project_id)
            if method == "projects.resume":
                self.chat.store.history(session_id)
                store.bind(session_id, project_id)
                return {"message": store.summary(project_id)}
            if method == "projects.save":
                result = store.save(params)
            elif method == "projects.archive":
                result = store.archive(project_id, params.get("archived"))
            elif method == "projects.manual":
                return store.draft(project_id, [], [])
            elif method == "projects.dismiss":
                store.dismiss(params.get("draft_id"))
                return {"ok": True}
            elif method == "projects.commit":
                result = store.commit(params)
            elif method == "projects.delete-snapshot":
                if params.get("confirm") is not True:
                    raise RequestError("请确认删除这份快照。")
                result = store.delete_snapshot(project_id, params.get("snapshot_id"))
            elif method == "projects.draft":
                project = store.get(project_id)
                if project["archived"]:
                    raise RequestError("请先恢复项目。")
                ids = params.get("source_ids")
                if (
                    not isinstance(ids, list)
                    or not 1 <= len(ids) <= 20
                    or not all(isinstance(i, str) for i in ids)
                ):
                    raise RequestError("请选择 1–20 条来源。")
                available = self._project_sources(session_id)
                sources = [s for s in available if s["id"] in ids]
                if len(sources) != len(set(ids)) or sum(len(s["content"]) for s in sources) > 20000:
                    raise RequestError("来源已变化或超过 20000 字，请减少选择后重试。")
                epoch = store.epoch
                llm = self.config.llm.model_copy(deep=True)
            else:
                raise RequestError("不支持的项目操作。")
        if method == "projects.draft":
            items = asyncio.run(self.project_ai.summarize(llm, project, sources))
            with store.lock:
                if epoch != store.epoch:
                    raise RequestError("整理已取消或模型/来源已变化，请重新整理。")
                return store.draft(project_id, items, sources, project["revision"], session_id)
        self.emit("projects.changed", {"id": result["id"]})
        return result

    def _update(self, job_id: str, **values) -> None:
        with self.lock:
            self.jobs[job_id].update(values)
            if values.get("status") in {"finished", "failed"} and self.active == job_id:
                self.active = None
            snapshot = dict(self.jobs[job_id])
        self.emit("job.changed", snapshot)

    def _generate(self, job_id: str, date: str, collect: bool) -> None:
        try:
            # Also prevents competing desktop runtimes on the same database.
            lock_path = self.config.data_path() / "desktop-report.lock"
            with lock_path.open("a") as lock_file:
                try:
                    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise RequestError("另一个 Otter 桌面实例正在生成简报。") from None
                self._update(
                    job_id,
                    status="running",
                    message="采集工作记录" if collect else "整理简报",
                )
                warnings: list[str] = []
                with open_store(self.config) as store:
                    orch = make_orchestrator(self.config, store)
                    if collect:
                        daily = orch.run_daily(date)
                        if daily.collect.collector_errors:
                            warnings.append(
                                "部分数据源采集失败：" + "、".join(daily.collect.collector_errors)
                            )
                    else:
                        since, until = orch._window_from_date(date)
                        orch.report_only(date, since, until)
                    report = store.get_report(date)
                    if report is None:
                        raise RequestError("简报未保存，请重试。")
                    notify_report(self.config, report, warnings.append)
                self._update(job_id, status="finished", message="简报已保存", warnings=warnings)
        except RequestError as exc:
            self._update(job_id, status="failed", message=str(exc))
        except Exception:
            # Providers may put tokens or private request bodies in exceptions.
            self._update(
                job_id,
                status="failed",
                message="生成失败，请检查模型、密钥和数据源配置。",
            )
        finally:
            with self.lock:
                if self.active == job_id:
                    self.active = None

    def close(self) -> None:
        self.chat.close()
        self.worker.shutdown(wait=True, cancel_futures=True)


def serve(
    config: Config,
    incoming,
    outgoing,
    model_path: Path | None = None,
    audio_dir: Path | None = None,
) -> None:
    output_lock = threading.Lock()

    def write(payload):
        with output_lock:
            outgoing.write(json.dumps(payload, ensure_ascii=False) + "\n")
            outgoing.flush()

    def emit(method, payload):
        write({"jsonrpc": "2.0", "method": method, "params": payload})

    runtime = Runtime(config, emit, model_path, audio_dir)
    tester = ThreadPoolExecutor(max_workers=1, thread_name_prefix="otter-model-test")
    test_slot = threading.Lock()

    def test_model(request_id, method, params):
        try:
            result = runtime.dispatch(method, params)
            write({"jsonrpc": "2.0", "id": request_id, "result": result})
        except (LLMError, RequestError) as exc:
            write(
                {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": str(exc)}}
            )
        except Exception:
            write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32603, "message": "连接失败，请检查配置与钥匙串权限。"},
                }
            )
        finally:
            test_slot.release()

    try:
        while True:
            line = incoming.readline(MAX_LINE + 1)
            if not line:
                break
            request_id = None
            try:
                if len(line) > MAX_LINE:
                    # Drain this frame so its tail cannot be interpreted as a request.
                    while line and not line.endswith("\n"):
                        line = incoming.readline(MAX_LINE + 1)
                    raise RequestError("请求过大。")
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise RequestError("请求必须为对象。")
                request_id = request.get("id")
                if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                    request_id = None
                    raise RequestError("请求缺少有效 id。")
                if request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
                    raise RequestError("协议格式无效。")
                params = request.get("params", {})
                if not isinstance(params, dict):
                    raise RequestError("params 必须为对象。")
                if request["method"] in {
                    "models.test",
                    "voice.transcribe",
                    "tasks.plan",
                    "projects.draft",
                }:
                    if not test_slot.acquire(blocking=False):
                        raise RequestError("模型请求正在进行，请稍后重试。")
                    tester.submit(test_model, request_id, request["method"], params)
                    continue
                result = runtime.dispatch(request["method"], params)
                write({"jsonrpc": "2.0", "id": request_id, "result": result})
            except (RequestError, LLMError, json.JSONDecodeError) as exc:
                message = (
                    str(exc) if isinstance(exc, (RequestError, LLMError)) else "JSON 格式无效。"
                )
                write(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32600, "message": message},
                    }
                )
            except Exception:
                write(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32603, "message": "操作失败，请检查配置或数据库。"},
                    }
                )
    finally:
        tester.shutdown(wait=True)
        runtime.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--model-settings", type=Path)
    parser.add_argument("--audio-dir", type=Path)
    args = parser.parse_args()
    os.environ["OTTER_PROJECT_ROOT"] = str(Path(args.root).resolve())
    _reset_cache_for_tests()
    protocol_output = sys.stdout
    # Any collector/provider/notifier printing goes to stderr, not the protocol pipe.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            serve(
                load(Path(args.config).resolve()),
                sys.stdin,
                protocol_output,
                args.model_settings,
                args.audio_dir,
            )
        except Exception:
            print("Otter 后台启动失败，请检查所选配置、时区与数据目录。", file=sys.stderr)
            raise SystemExit(1) from None


if __name__ == "__main__":
    main()
