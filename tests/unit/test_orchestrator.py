"""Orchestrator 单测 —— 覆盖 graph 各条路径、失败隔离、幂等重跑。

用两个 fake collector + MockProvider 走端到端;不打网络,不动真实 keyring。
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, ClassVar

import pytest

from otter.core.config import (
    Config,
    CoreCfg,
    IdentityCfg,
    LLMCfg,
)
from otter.core.event import Event, Ref
from otter.core.keychain import SecretResolver
from otter.core.orchestrator import (
    CollectResult,
    DailyResult,
    Orchestrator,
    ReportResult,
)
from otter.core.registry import PluginRegistry
from otter.core.store import Store
from otter.llm.mock import MockProvider
from otter.summarizer.renderer import Renderer

# ────────────────────── Fixtures ──────────────────────


class _NullResolver:
    """测试用:所有 ref 都返回 'x'。"""

    def resolve(self, ref: str) -> str:  # noqa: ARG002
        return "x"


class _FakeCollector:
    """基类:子类填 `name` 和 `_events`。"""

    name: ClassVar[str] = "fake"
    _events: ClassVar[list[Event]] = []

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,
        identity: str,
    ) -> None:
        self.config = config
        self.identity = identity
        self.calls: list[tuple[datetime, datetime]] = []

    def collect(self, since: datetime, until: datetime) -> Iterable[Event]:
        self.calls.append((since, until))
        return iter(self._events)


def _make_event(source: str, source_id: str, ts: datetime, title: str) -> Event:
    return Event.build(
        source=source,
        source_id=source_id,
        type="commit" if source == "git" else "pr_review",
        timestamp=ts,
        title=title,
        refs=[Ref(kind="repo", id="demo")],
    )


def _mk_config(
    *,
    tmp_path: Path,
    timezone: str = "Asia/Shanghai",
    collectors: dict[str, dict[str, Any]] | None = None,
    llm_provider: str = "mock",
) -> Config:
    """造一个不走 toml 文件、直接构造的 Config。"""
    return Config(
        schema_version=1,
        core=CoreCfg(
            timezone=timezone,
            data_dir=str(tmp_path / "data"),
            report_dir=str(tmp_path / "reports"),
            log_dir=str(tmp_path / "logs"),
        ),
        identity=IdentityCfg(primary="guoyang.zou@sap.com"),
        llm=LLMCfg.model_validate(
            {"provider": llm_provider, "mock": {"response": "# 简报(mock)\n- ok"}}
        ),
        collectors=collectors
        or {
            "alpha": {"enabled": True},
            "beta": {"enabled": True},
        },
    )


@pytest.fixture
def store(tmp_path: Path) -> Iterator[Store]:
    db = tmp_path / "otter.db"
    with Store(db) as s:
        s.migrate()
        yield s


@pytest.fixture
def registries() -> Iterator[tuple[PluginRegistry, PluginRegistry]]:
    """独立的 collector / llm registry,避免和 entry_points 全局状态串扰。"""
    col: PluginRegistry = PluginRegistry("test.collectors")
    llm: PluginRegistry = PluginRegistry("test.llm")
    llm.register("mock", MockProvider)
    yield col, llm


# ────────────────────── run_daily 端到端 ──────────────────────


def test_run_daily_end_to_end(tmp_path: Path, store: Store, registries) -> None:
    col_reg, llm_reg = registries
    events_alpha = [
        _make_event("alpha", "c1", datetime(2026, 8, 26, 2, 0, tzinfo=UTC), "commit A"),
        _make_event("alpha", "c2", datetime(2026, 8, 26, 3, 0, tzinfo=UTC), "commit B"),
    ]
    events_beta = [
        _make_event("beta", "e1", datetime(2026, 8, 26, 4, 0, tzinfo=UTC), "review C"),
    ]

    class Alpha(_FakeCollector):
        name = "alpha"
        _events = events_alpha

    class Beta(_FakeCollector):
        name = "beta"
        _events = events_beta

    col_reg.register("alpha", Alpha)
    col_reg.register("beta", Beta)

    cfg = _mk_config(tmp_path=tmp_path)
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    result = orch.run_daily("2026-08-26")

    assert isinstance(result, DailyResult)
    # 事件已入库
    assert store.event_count() == 3
    # collector 结果汇总
    assert result.collect.total_events == 3
    assert result.collect.upsert_stats["inserted"] == 3
    assert result.collect.collector_errors == {}
    # 报告已生成
    assert result.report is not None
    assert result.report.date == "2026-08-26"
    md_path = Path(result.report.report_path)
    assert md_path.exists()
    assert "mock" in md_path.read_text(encoding="utf-8")
    # SQLite reports 表也写了
    r = store.get_report("2026-08-26")
    assert r is not None
    assert r.event_count == 3
    assert r.llm_provider == "mock"


# ────────────────────── 失败隔离 ──────────────────────


def test_collector_failure_isolated(
    tmp_path: Path, store: Store, registries
) -> None:
    col_reg, llm_reg = registries

    class GoodCollector(_FakeCollector):
        name = "good"
        _events = [
            _make_event("good", "g1", datetime(2026, 8, 26, 2, 0, tzinfo=UTC), "ok"),
        ]

    class BadCollector(_FakeCollector):
        name = "bad"

        def collect(self, since: datetime, until: datetime):  # noqa: ARG002
            raise RuntimeError("boom")

    col_reg.register("good", GoodCollector)
    col_reg.register("bad", BadCollector)

    cfg = _mk_config(
        tmp_path=tmp_path,
        collectors={"good": {"enabled": True}, "bad": {"enabled": True}},
    )
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    result = orch.run_daily("2026-08-26")

    # 好 collector 的事件入库了
    assert store.event_count() == 1
    # 失败被记录
    assert "bad" in result.collect.collector_errors
    assert "boom" in result.collect.collector_errors["bad"]
    # 但 generate 阶段仍继续
    assert result.report is not None
    assert Path(result.report.report_path).exists()

    # collector_state 也反映了错误
    state_bad = store.get_collector_state("bad")
    assert state_bad is not None
    assert state_bad.last_error is not None
    assert "boom" in state_bad.last_error
    assert state_bad.last_ok_at is None

    state_good = store.get_collector_state("good")
    assert state_good is not None
    assert state_good.last_error is None
    assert state_good.last_ok_at is not None


# ────────────────────── collect_only ──────────────────────


def test_collect_only_skips_generate(tmp_path: Path, store: Store, registries) -> None:
    col_reg, llm_reg = registries

    class C(_FakeCollector):
        name = "c"
        _events = [_make_event("c", "1", datetime(2026, 8, 26, 2, 0, tzinfo=UTC), "x")]

    col_reg.register("c", C)

    cfg = _mk_config(tmp_path=tmp_path, collectors={"c": {"enabled": True}})
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    result = orch.collect_only(
        since=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 27, 0, 0, tzinfo=UTC),
    )
    assert isinstance(result, CollectResult)
    assert result.total_events == 1
    assert store.event_count() == 1
    # 没有生成 report
    assert store.get_report("2026-08-26") is None
    # reports 目录也不该有 md
    reports_dir = tmp_path / "reports"
    assert not reports_dir.exists() or not list(reports_dir.glob("*.md"))


# ────────────────────── report_only ──────────────────────


def test_report_only_uses_stored_events(
    tmp_path: Path, store: Store, registries
) -> None:
    col_reg, llm_reg = registries

    # 手动 upsert 一些事件,不通过 collector
    events = [
        _make_event("git", "c1", datetime(2026, 8, 26, 2, 0, tzinfo=UTC), "commit"),
    ]
    store.upsert_events(events)

    cfg = _mk_config(tmp_path=tmp_path, collectors={})
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    result = orch.report_only(
        date="2026-08-26",
        since=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 27, 0, 0, tzinfo=UTC),
    )
    assert isinstance(result, ReportResult)
    assert result.date == "2026-08-26"
    assert Path(result.report_path).exists()
    r = store.get_report("2026-08-26")
    assert r is not None
    assert r.event_count == 1


# ────────────────────── 窗口计算 ──────────────────────


def test_window_computed_from_local_tz(
    tmp_path: Path, store: Store, registries
) -> None:
    col_reg, llm_reg = registries

    captured: dict[str, tuple[datetime, datetime]] = {}

    class Cap(_FakeCollector):
        name = "cap"
        _events = []

        def collect(self, since: datetime, until: datetime):
            captured["window"] = (since, until)
            return iter([])

    col_reg.register("cap", Cap)

    cfg = _mk_config(
        tmp_path=tmp_path,
        timezone="Asia/Shanghai",
        collectors={"cap": {"enabled": True}},
    )
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    orch.run_daily("2026-08-26")

    since, until = captured["window"]
    # 2026-08-26 00:00 Asia/Shanghai = 2026-08-25 16:00 UTC
    assert since == datetime(2026, 8, 25, 16, 0, tzinfo=UTC)
    assert until == datetime(2026, 8, 26, 16, 0, tzinfo=UTC)
    assert until - since == timedelta(days=1)


# ────────────────────── LLM trace ──────────────────────


def test_llm_trace_written(tmp_path: Path, store: Store, registries) -> None:
    col_reg, llm_reg = registries

    class C(_FakeCollector):
        name = "c"
        _events = [_make_event("c", "1", datetime(2026, 8, 26, 2, 0, tzinfo=UTC), "x")]

    col_reg.register("c", C)

    cfg = _mk_config(tmp_path=tmp_path, collectors={"c": {"enabled": True}})
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    orch.run_daily("2026-08-26")

    rows = store._conn.execute(  # noqa: SLF001
        "SELECT provider, model, prompt, response FROM llm_traces"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["provider"] == "mock"
    assert "[SYSTEM]" in rows[0]["prompt"]
    assert "[USER]" in rows[0]["prompt"]
    assert rows[0]["response"]


# ────────────────────── 空事件 ──────────────────────


def test_empty_events_still_generates(
    tmp_path: Path, store: Store, registries
) -> None:
    col_reg, llm_reg = registries

    class Empty(_FakeCollector):
        name = "empty"
        _events = []

    col_reg.register("empty", Empty)

    cfg = _mk_config(tmp_path=tmp_path, collectors={"empty": {"enabled": True}})
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    result = orch.run_daily("2026-08-26")

    assert store.event_count() == 0
    assert result.report is not None
    assert Path(result.report.report_path).exists()
    r = store.get_report("2026-08-26")
    assert r is not None
    assert r.event_count == 0


# ────────────────────── 幂等重跑 ──────────────────────


def test_rerun_is_idempotent(tmp_path: Path, store: Store, registries) -> None:
    col_reg, llm_reg = registries

    class Same(_FakeCollector):
        name = "same"
        _events = [
            _make_event("same", "e1", datetime(2026, 8, 26, 2, 0, tzinfo=UTC), "x"),
        ]

    col_reg.register("same", Same)

    cfg = _mk_config(tmp_path=tmp_path, collectors={"same": {"enabled": True}})
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    orch.run_daily("2026-08-26")
    r1 = orch.run_daily("2026-08-26")

    # 第二次:0 insert,1 unchanged
    assert r1.collect.upsert_stats["inserted"] == 0
    assert r1.collect.upsert_stats["unchanged"] == 1
    # 事件总数仍是 1
    assert store.event_count() == 1
    # reports 表也只有一行(save_report 是 ON CONFLICT DO UPDATE)
    assert len(store.list_reports()) == 1


# ────────────────────── enabled=false 跳过 ──────────────────────


def test_disabled_collector_skipped(
    tmp_path: Path, store: Store, registries
) -> None:
    col_reg, llm_reg = registries

    class On(_FakeCollector):
        name = "on"
        _events = [_make_event("on", "1", datetime(2026, 8, 26, 2, 0, tzinfo=UTC), "x")]

    class Off(_FakeCollector):
        name = "off"

        def collect(self, since, until):  # noqa: ARG002
            raise AssertionError("不应该被调用")

    col_reg.register("on", On)
    col_reg.register("off", Off)

    cfg = _mk_config(
        tmp_path=tmp_path,
        collectors={"on": {"enabled": True}, "off": {"enabled": False}},
    )
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    result = orch.run_daily("2026-08-26")
    assert set(result.collect.events_by_source.keys()) == {"on"}


# ────────────────────── 参数校验 ──────────────────────


def test_invalid_date_raises(tmp_path: Path, store: Store, registries) -> None:
    col_reg, llm_reg = registries
    cfg = _mk_config(tmp_path=tmp_path, collectors={})
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    from otter.core.orchestrator import OrchestratorError

    with pytest.raises(OrchestratorError, match="date 格式"):
        orch.run_daily("not-a-date")


def test_llm_provider_override(tmp_path: Path, store: Store, registries) -> None:
    col_reg, llm_reg = registries
    # 注册一个第二种 mock,response 不一样
    class LoudMock(MockProvider):
        pass

    llm_reg.register("loud", LoudMock)

    class C(_FakeCollector):
        name = "c"
        _events = []

    col_reg.register("c", C)

    cfg = _mk_config(
        tmp_path=tmp_path,
        collectors={"c": {"enabled": True}},
        llm_provider="mock",
    )
    # 注入 loud 的 provider 配置
    cfg.llm.providers["loud"] = {"response": "OVERRIDE-OUTPUT"}
    orch = Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(),
        resolver=_NullResolver(),
        collectors_registry=col_reg,
        llm_registry=llm_reg,
    )
    result = orch.run_daily("2026-08-26", llm_provider="loud")
    assert result.report is not None
    assert "OVERRIDE-OUTPUT" in Path(result.report.report_path).read_text(
        encoding="utf-8"
    )
