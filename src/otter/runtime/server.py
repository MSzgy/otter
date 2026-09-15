"""Bounded JSON-RPC over stdio. A single worker owns report jobs and its Store."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from otter.application.reports import make_orchestrator, notify_report, open_store
from otter.core.config import Config, load
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
    def __init__(self, config: Config, emit):
        self.config = config
        self.emit = emit
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="otter-report")
        self.jobs: dict[str, dict] = {}
        self.active: str | None = None
        # Connections are opened/closed on their owning thread, never passed to workers.
        with open_store(config):
            pass

    def dispatch(self, method: str, params: dict) -> Any:
        if method == "health.get":
            now = datetime.now(ZoneInfo(self.config.core.timezone))
            return {
                "protocol_version": 1, "provider": self.config.llm.provider,
                "demo": self.config.llm.provider == "mock",
                "timezone": self.config.core.timezone,
                "today": now.date().isoformat(),
                "yesterday": (now.date() - timedelta(days=1)).isoformat(),
                "collectors": [name for name, cfg in self.config.collectors.items()
                               if cfg.get("enabled", True)],
            }
        if method == "reports.list":
            with open_store(self.config) as store:
                return [r.model_dump(mode="json", exclude={"content_md", "trace_path"})
                        for r in store.list_reports(limit=60)]
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
                    job_id, status="running",
                    message="采集工作记录" if collect else "整理简报",
                )
                warnings: list[str] = []
                with open_store(self.config) as store:
                    orch = make_orchestrator(self.config, store)
                    if collect:
                        daily = orch.run_daily(date)
                        if daily.collect.collector_errors:
                            warnings.append("部分数据源采集失败：" + "、".join(
                                daily.collect.collector_errors))
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
                job_id, status="failed",
                message="生成失败，请检查模型、密钥和数据源配置。",
            )
        finally:
            with self.lock:
                if self.active == job_id:
                    self.active = None

    def close(self) -> None:
        self.worker.shutdown(wait=True, cancel_futures=True)


def serve(config: Config, incoming, outgoing) -> None:
    output_lock = threading.Lock()

    def write(payload):
        with output_lock:
            outgoing.write(json.dumps(payload, ensure_ascii=False) + "\n")
            outgoing.flush()

    def emit(method, payload):
        write({"jsonrpc": "2.0", "method": method, "params": payload})

    runtime = Runtime(config, emit)
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
                result = runtime.dispatch(request["method"], params)
                write({"jsonrpc": "2.0", "id": request_id, "result": result})
            except (RequestError, json.JSONDecodeError) as exc:
                message = str(exc) if isinstance(exc, RequestError) else "JSON 格式无效。"
                write({"jsonrpc": "2.0", "id": request_id,
                       "error": {"code": -32600, "message": message}})
            except Exception:
                write({"jsonrpc": "2.0", "id": request_id,
                       "error": {"code": -32603, "message": "操作失败，请检查配置或数据库。"}})
    finally:
        runtime.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    os.environ["OTTER_PROJECT_ROOT"] = str(Path(args.root).resolve())
    _reset_cache_for_tests()
    protocol_output = sys.stdout
    # Any collector/provider/notifier printing goes to stderr, not the protocol pipe.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            serve(load(Path(args.config).resolve()), sys.stdin, protocol_output)
        except Exception:
            print("Otter 后台启动失败，请检查所选配置、时区与数据目录。", file=sys.stderr)
            raise SystemExit(1) from None


if __name__ == "__main__":
    main()
