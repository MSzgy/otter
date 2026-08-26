"""Orchestrator —— 用 LangGraph 编排每日采集 + 生成简报的主流程。

设计要点(见 docs/ARCHITECTURE.md §9,以及 .claude/plans/atomic-kindling-flute.md):

    Graph 结构:
        START ──(Send fan-out)──→ collect_<name>  ┐
                                  collect_<name>  ├──→ persist ──→ [skip_generate?]
                                  …               ┘        │
                                                            ├─→ END(仅采集)
                                                            │
                                                    render ─→ llm ─→ save ─→ END

    - 每个 enabled 的 Collector 是独立节点,START 用 Send API 动态 fan-out;
      新增 Collector 时只要 config 里开启,graph 会自动接上,不改代码。
    - Collector 节点内部 try/except:失败写 `collector_errors` 而不抛出;
      persist / render / llm / save 则直接抛(没有 fallback)。
    - Store 已有 `upsert_events`(id + content_hash 幂等)、`save_report`
      (date 覆盖式)、`llm_traces` 表(prompt/response 审计),这些是本模块
      直接使用的原语,不重复实现。
    - 不用 checkpointer:每天一次,失败重跑靠 Store 幂等去重就够;后续要加
      人工审阅 / 长跑 agent 时再挂 SqliteSaver。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, TypedDict
from zoneinfo import ZoneInfo

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from otter.core.config import Config
from otter.core.event import Event
from otter.core.keychain import SecretResolver
from otter.core.llm import LLMError, LLMResponse
from otter.core.registry import COLLECTORS, LLM_PROVIDERS, PluginRegistry
from otter.core.store import CollectorState, Report, Store
from otter.summarizer.renderer import RenderedPrompt, Renderer

logger = logging.getLogger(__name__)


class OrchestratorError(Exception):
    """Orchestrator 层错误(非采集失败,那类走 collector_errors)。"""


# ────────────────────── State ──────────────────────


def _merge_dicts(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """LangGraph reducer:并行分支的 dict 输出按 key 合并。

    fan-out 时每个 collector 节点只写自己的 key,不会冲突;这里的 update
    只是把两个分支的结果拼起来。
    """
    out = dict(a)
    out.update(b)
    return out


class OtterState(TypedDict, total=False):
    """LangGraph state。TypedDict 而非 pydantic,与 LangGraph 主流用法一致。"""

    # 输入(初始化时填,后续节点只读)
    date: str                       # 本地 YYYY-MM-DD
    since: datetime                 # UTC tz-aware
    until: datetime
    timezone: str
    identity: str
    enabled_collectors: list[str]
    llm_provider_name: str          # 允许 CLI 覆盖 config 里的 provider
    skip_generate: bool

    # collect 阶段 fan-out 产出
    events_by_source: Annotated[dict[str, list[Event]], _merge_dicts]
    collector_errors: Annotated[dict[str, str], _merge_dicts]

    # persist 阶段产出
    upsert_stats: dict[str, int]

    # generate 阶段产出
    prompt: RenderedPrompt
    llm_response: LLMResponse
    report_path: str                # 落地 md 的绝对路径(字符串,便于 JSON 化)
    event_count: int                # 落盘 report 里的真实事件数(从 store 读)


# ────────────────────── 结果 DTO ──────────────────────


@dataclass
class CollectResult:
    since: datetime
    until: datetime
    events_by_source: dict[str, list[Event]] = field(default_factory=dict)
    collector_errors: dict[str, str] = field(default_factory=dict)
    upsert_stats: dict[str, int] = field(default_factory=dict)

    @property
    def total_events(self) -> int:
        return sum(len(v) for v in self.events_by_source.values())


@dataclass
class ReportResult:
    date: str
    report_path: str
    event_count: int
    llm_provider: str
    llm_model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


@dataclass
class DailyResult:
    collect: CollectResult
    report: ReportResult | None      # skip_generate=True 时为 None


# ────────────────────── 节点工厂 ──────────────────────


def _make_collect_node(
    name: str,
    *,
    config: Config,
    resolver: SecretResolver,
    collectors_registry: PluginRegistry[Any],
) -> Callable[[OtterState], dict[str, Any]]:
    """给单个 collector 造一个节点函数。闭包捕获依赖,避免节点内再查 registry。"""

    def _node(state: OtterState) -> dict[str, Any]:
        try:
            cls = collectors_registry.get(name)
            collector = cls(
                config=config.collector_config(name),
                resolver=resolver,
                identity=config.identity.primary,
            )
            events = list(collector.collect(state["since"], state["until"]))
            logger.info("collector %s: %d events", name, len(events))
            return {"events_by_source": {name: events}}
        except Exception as e:
            # 错误已经通过 state 传给 CLI(Status 列会展示),这里只记 warning,
            # 不打 traceback,免得污染 stdout/stderr。想看细节可开 DEBUG。
            logger.warning("collector %s failed: %s", name, e)
            logger.debug("collector %s traceback", name, exc_info=True)
            return {
                "events_by_source": {name: []},
                "collector_errors": {name: repr(e)},
            }

    _node.__name__ = f"collect_{name}"
    return _node


def _persist_node(
    state: OtterState,
    *,
    store: Store,
) -> dict[str, Any]:
    """把所有 collector 产出的 events 一次性 upsert,并更新 collector_state。"""
    all_events: list[Event] = []
    for evs in state.get("events_by_source", {}).values():
        all_events.extend(evs)

    result = store.upsert_events(all_events)
    stats = {
        "inserted": result.inserted,
        "updated": result.updated,
        "unchanged": result.unchanged,
        "total": result.total,
    }
    logger.info("persist: %s", stats)

    # 更新 collector_state:成功记 last_ok_at,失败记 last_error
    now = datetime.now(UTC)
    errors = state.get("collector_errors", {})
    for src in state.get("events_by_source", {}):
        err = errors.get(src)
        store.set_collector_state(
            CollectorState(
                source=src,
                last_run_at=now,
                last_cursor=None,
                last_error=err,
                last_ok_at=None if err else now,
            )
        )
    return {"upsert_stats": stats}


def _render_node(
    state: OtterState,
    *,
    store: Store,
    renderer: Renderer,
) -> dict[str, Any]:
    """从 Store 重新拉窗口内 events(包含历史累积)再渲染。"""
    events = store.query_events(state["since"], state["until"])
    prompt = renderer.render_daily(
        date=state["date"],
        timezone=state["timezone"],
        identity=state["identity"],
        since=state["since"],
        until=state["until"],
        events=events,
    )
    return {"prompt": prompt}


def _llm_node(
    state: OtterState,
    *,
    config: Config,
    resolver: SecretResolver,
    store: Store,
    llm_registry: PluginRegistry[Any],
) -> dict[str, Any]:
    """调 LLM,同时把一次调用记入 llm_traces。"""
    provider_name = state["llm_provider_name"]
    cls = llm_registry.get(provider_name)
    provider = cls(
        config=config.llm.provider_config(provider_name),
        resolver=resolver,
    )
    prompt: RenderedPrompt = state["prompt"]

    t0 = time.monotonic()
    try:
        resp = provider.generate(prompt.user, system=prompt.system)
    except Exception as e:
        raise LLMError(f"LLM 调用失败({provider_name}):{e}") from e
    duration_ms = int((time.monotonic() - t0) * 1000)

    # 写 llm_traces(尽力而为,失败不阻塞主流程)
    try:
        _write_llm_trace(store, prompt=prompt, response=resp, duration_ms=duration_ms)
    except Exception:
        logger.exception("写 llm_traces 失败,忽略")

    return {"llm_response": resp}


def _save_node(
    state: OtterState,
    *,
    config: Config,
    store: Store,
) -> dict[str, Any]:
    """把 report 存 SQLite,同时落一份 md 到 report_dir。"""
    resp: LLMResponse = state["llm_response"]
    date: str = state["date"]

    report_dir = config.report_path()
    report_dir.mkdir(parents=True, exist_ok=True)
    md_path = report_dir / f"{date}.md"
    md_path.write_text(resp.content, encoding="utf-8")

    # 事件数取当日窗口内 store 里的实际数(不是内存里的 events_by_source,
    # 因为 render 阶段已经从 store 读了,以那个为准)
    event_count = len(store.query_events(state["since"], state["until"]))

    report = Report(
        date=date,
        content_md=resp.content,
        llm_provider=resp.provider,
        llm_model=resp.model,
        generated_at=datetime.now(UTC),
        event_count=event_count,
        prompt_tokens=resp.prompt_tokens,
        completion_tokens=resp.completion_tokens,
        trace_path=str(md_path),
    )
    store.save_report(report)
    logger.info("report saved: %s (%d events)", md_path, event_count)
    return {"report_path": str(md_path), "event_count": event_count}


# ────────────────────── LLM Trace ──────────────────────


def _write_llm_trace(
    store: Store,
    *,
    prompt: RenderedPrompt,
    response: LLMResponse,
    duration_ms: int,
) -> None:
    """把一次 LLM 调用写到 llm_traces 表(审计用)。"""
    import hashlib
    full_prompt = f"[SYSTEM]\n{prompt.system}\n\n[USER]\n{prompt.user}"
    prompt_hash = hashlib.sha256(full_prompt.encode("utf-8")).hexdigest()[:16]
    store._conn.execute(  # noqa: SLF001 — 内部审计写,不值得单开公开 API
        """
        INSERT INTO llm_traces(ts, provider, model, prompt_hash, prompt, response, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(datetime.now(UTC).timestamp()),
            response.provider,
            response.model,
            prompt_hash,
            full_prompt,
            response.content,
            duration_ms,
        ),
    )


# ────────────────────── Graph 构建 ──────────────────────


def _fan_out(state: OtterState) -> list[Send]:
    """START 的条件边:按 enabled_collectors 动态派发到 collect_<name> 节点。

    没有任何 collector 时(如 report_only 场景),直接 Send 到 persist,
    让 graph 一路走完 render → llm → save。
    """
    names = state["enabled_collectors"]
    if not names:
        return [Send("persist", state)]
    return [Send(f"collect_{name}", state) for name in names]


def _should_generate(state: OtterState) -> str:
    return END if state.get("skip_generate", False) else "render"


# ────────────────────── Orchestrator 门面 ──────────────────────


class Orchestrator:
    """把 config / store / renderer / registry 组装成一个可跑的 graph。"""

    def __init__(
        self,
        *,
        config: Config,
        store: Store,
        renderer: Renderer,
        resolver: SecretResolver,
        collectors_registry: PluginRegistry[Any] = COLLECTORS,
        llm_registry: PluginRegistry[Any] = LLM_PROVIDERS,
    ) -> None:
        self._config = config
        self._store = store
        self._renderer = renderer
        self._resolver = resolver
        self._collectors_registry = collectors_registry
        self._llm_registry = llm_registry
        self._graph = self._build_graph()

    # ── 公开入口 ──

    def run_daily(
        self,
        date: str,
        *,
        llm_provider: str | None = None,
    ) -> DailyResult:
        """采集 + 生成一体化。date 是本地 YYYY-MM-DD。"""
        since, until = self._window_from_date(date)
        state = self._invoke(
            date=date,
            since=since,
            until=until,
            skip_generate=False,
            llm_provider=llm_provider,
        )
        return DailyResult(
            collect=self._to_collect_result(state, since, until),
            report=self._to_report_result(state),
        )

    def collect_only(
        self,
        since: datetime,
        until: datetime,
    ) -> CollectResult:
        """只跑采集 + 入库,不生成简报。CLI 的 `otter collect` 用这条。"""
        state = self._invoke(
            date="",           # 采集不需要 date;render 阶段跳过
            since=since,
            until=until,
            skip_generate=True,
            llm_provider=None,
        )
        return self._to_collect_result(state, since, until)

    def report_only(
        self,
        date: str,
        since: datetime,
        until: datetime,
        *,
        llm_provider: str | None = None,
    ) -> ReportResult:
        """只跑渲染 + LLM + 保存。假设 events 已在 Store。CLI `otter report` 用。

        实现上是构造一个"没有启用任何 collector"的 state,persist 会写零条,
        然后正常进入 render → llm → save。
        """
        state = self._invoke(
            date=date,
            since=since,
            until=until,
            skip_generate=False,
            llm_provider=llm_provider,
            enabled_collectors_override=[],
        )
        result = self._to_report_result(state)
        if result is None:
            raise OrchestratorError("report_only 未生成 report,内部状态异常")
        return result

    # ── 内部 ──

    def _invoke(
        self,
        *,
        date: str,
        since: datetime,
        until: datetime,
        skip_generate: bool,
        llm_provider: str | None,
        enabled_collectors_override: list[str] | None = None,
    ) -> OtterState:
        enabled = (
            enabled_collectors_override
            if enabled_collectors_override is not None
            else self._enabled_collectors()
        )
        initial: OtterState = {
            "date": date,
            "since": since,
            "until": until,
            "timezone": self._config.core.timezone,
            "identity": self._config.identity.primary,
            "enabled_collectors": enabled,
            "llm_provider_name": llm_provider or self._config.llm.provider,
            "skip_generate": skip_generate,
            "events_by_source": {},
            "collector_errors": {},
        }
        return self._graph.invoke(initial)  # type: ignore[return-value]

    def _enabled_collectors(self) -> list[str]:
        """config 里 enabled=true(默认视为 true)且在 registry 里存在的 collector。"""
        out: list[str] = []
        for name, sub in self._config.collectors.items():
            if sub.get("enabled", True) and name in self._collectors_registry:
                out.append(name)
        return sorted(out)

    def _window_from_date(self, date: str) -> tuple[datetime, datetime]:
        try:
            tz = ZoneInfo(self._config.core.timezone)
        except Exception as e:
            raise OrchestratorError(f"未知时区 {self._config.core.timezone!r}") from e
        try:
            local_midnight = datetime.fromisoformat(date).replace(tzinfo=tz)
        except ValueError as e:
            raise OrchestratorError(f"date 格式非法(需 YYYY-MM-DD):{date!r}") from e
        since = local_midnight.astimezone(UTC)
        until = (local_midnight + timedelta(days=1)).astimezone(UTC)
        return since, until

    # ── Graph 构建 ──

    def _build_graph(self):
        g: StateGraph = StateGraph(OtterState)

        # collector 节点:按 registry 里所有已知 collector 加节点(未启用的运行时
        # 不会被 fan-out 分发到,不影响)。这样 graph shape 稳定,便于调试。
        for name in self._collectors_registry.names():
            node = _make_collect_node(
                name,
                config=self._config,
                resolver=self._resolver,
                collectors_registry=self._collectors_registry,
            )
            g.add_node(f"collect_{name}", node)

        g.add_node("persist", lambda s: _persist_node(s, store=self._store))
        g.add_node("render", lambda s: _render_node(
            s, store=self._store, renderer=self._renderer
        ))
        g.add_node("llm", lambda s: _llm_node(
            s,
            config=self._config,
            resolver=self._resolver,
            store=self._store,
            llm_registry=self._llm_registry,
        ))
        g.add_node("save", lambda s: _save_node(
            s, config=self._config, store=self._store
        ))

        # START → 动态 fan-out;所有 collect_* 汇入 persist
        g.add_conditional_edges(
            START,
            _fan_out,
            [f"collect_{n}" for n in self._collectors_registry.names()] or [END],
        )
        for name in self._collectors_registry.names():
            g.add_edge(f"collect_{name}", "persist")

        # persist → 条件边 → END | render → llm → save → END
        g.add_conditional_edges("persist", _should_generate, {"render": "render", END: END})
        g.add_edge("render", "llm")
        g.add_edge("llm", "save")
        g.add_edge("save", END)

        return g.compile()

    # ── 结果打包 ──

    @staticmethod
    def _to_collect_result(
        state: OtterState, since: datetime, until: datetime
    ) -> CollectResult:
        return CollectResult(
            since=since,
            until=until,
            events_by_source=dict(state.get("events_by_source", {})),
            collector_errors=dict(state.get("collector_errors", {})),
            upsert_stats=dict(state.get("upsert_stats", {})),
        )

    @staticmethod
    def _to_report_result(state: OtterState) -> ReportResult | None:
        path = state.get("report_path")
        resp = state.get("llm_response")
        if path is None or resp is None:
            return None
        # 优先用 save_node 从 store 读回的真实数;回退到 state 里 fan-out 的累计
        count = state.get("event_count")
        if count is None:
            events = state.get("events_by_source", {})
            count = sum(len(v) for v in events.values())
        return ReportResult(
            date=state["date"],
            report_path=path,
            event_count=count,
            llm_provider=resp.provider,
            llm_model=resp.model,
            prompt_tokens=resp.prompt_tokens,
            completion_tokens=resp.completion_tokens,
        )
