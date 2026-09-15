"""Desktop uses real mock-provider reports and thread-owned SQLite connections."""
import io
import json
import threading
from datetime import UTC, datetime

import pytest

from otter.core.config import Config
from otter.core.paths import _reset_cache_for_tests
from otter.core.store import Report, Store
from otter.runtime.server import MAX_LINE, RequestError, Runtime, serve


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
    _reset_cache_for_tests()
    yield Config.model_validate({
        "core": {"timezone": "Asia/Shanghai"},
        "identity": {"primary": "test@example.com"},
        "llm": {"provider": "mock", "mock": {"response": "# Desktop test"}},
    })
    _reset_cache_for_tests()


def test_report_generation_and_readback(config):
    finished = threading.Event()
    runtime = Runtime(config, lambda _method, job: finished.set()
                      if job["status"] in {"finished", "failed"} else None)
    try:
        assert runtime.dispatch("reports.list", {}) == []
        job = runtime.dispatch("reports.generate", {"date": "2026-09-14"})
        assert finished.wait(10)
        rows = runtime.dispatch("jobs.list", {})
        assert rows[0]["id"] == job["job_id"]
        assert rows[0]["status"] == "finished", rows
        report = runtime.dispatch("reports.get", {"date": "2026-09-14"})
        assert report["content_md"] == "# Desktop test"
        assert "trace_path" not in report
        assert "content_md" not in runtime.dispatch("reports.list", {})[0]
    finally:
        runtime.close()


def test_reject_duplicate_and_keep_reader_responsive(config, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    runtime = Runtime(config, lambda *_: None)

    def slow(*_args):
        entered.set()
        release.wait(5)

    monkeypatch.setattr(runtime, "_generate", slow)
    try:
        runtime.dispatch("reports.generate", {"date": "2026-09-14"})
        assert entered.wait(2)
        with pytest.raises(RequestError, match="已有简报"):
            runtime.dispatch("reports.generate", {"date": "2026-09-14"})
        assert runtime.dispatch("health.get", {})["today"]
        assert runtime.dispatch("reports.list", {}) == []
    finally:
        release.set()
        runtime.close()


def test_bad_protocol_frames_do_not_kill_runtime(config):
    incoming = io.StringIO('[]\nnot json\n' + 'x' * (MAX_LINE + 5) + '\n' + json.dumps({
        "jsonrpc": "2.0", "id": 4, "method": "health.get",
    }) + '\n')
    outgoing = io.StringIO()
    serve(config, incoming, outgoing)
    messages = [json.loads(line) for line in outgoing.getvalue().splitlines()]
    assert len(messages) == 4
    assert all("error" in m for m in messages[:3])
    assert messages[3]["result"]["demo"] is True


@pytest.mark.parametrize("params", [
    {"date": "../../secret"}, {"date": "2026-2-1"},
    {"date": "2026-02-30"}, {"date": "2026-09-14", "collect": "yes"},
])
def test_invalid_generation_never_starts(config, params):
    runtime = Runtime(config, lambda *_: None)
    try:
        with pytest.raises(RequestError):
            runtime.dispatch("reports.generate", params)
        assert runtime.dispatch("jobs.list", {}) == []
    finally:
        runtime.close()


def test_provider_error_does_not_disclose_credentials(config, monkeypatch):
    finished = threading.Event()
    runtime = Runtime(config, lambda _method, job: finished.set()
                      if job["status"] == "failed" else None)

    def fail(*_):
        raise ValueError("private-token-123")

    monkeypatch.setattr("otter.runtime.server.make_orchestrator", fail)
    try:
        runtime.dispatch("reports.generate", {"date": "2026-09-14"})
        assert finished.wait(5)
        assert "private-token" not in json.dumps(runtime.dispatch("jobs.list", {}))
    finally:
        runtime.close()


def test_existing_report_survives_runtime_start(config):
    with Store(config.data_path() / "otter.db") as store:
        store.migrate()
        store.save_report(Report(date="2026-09-13", content_md="# Existing",
                                 llm_provider="mock", llm_model="mock-v1",
                                 generated_at=datetime.now(UTC), event_count=0))
    runtime = Runtime(config, lambda *_: None)
    try:
        assert runtime.dispatch("reports.get", {"date": "2026-09-13"})["content_md"] == "# Existing"
    finally:
        runtime.close()
