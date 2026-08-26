"""SQLite 持久化层。

设计要点(见 docs/ARCHITECTURE.md §6):
    - 单一连接,autocommit + 显式事务,SQLite 单写者模型足够。
    - WAL 模式便于开发时可以旁观(如用 DB Browser 打开 db 也不锁死主进程)。
    - 迁移是 `NNN_*.sql` 文件顺序运行,状态记在 `schema_version` 表。
    - Event / Report / CollectorState 都用 pydantic 反向反序列化,保证从
      磁盘取出后仍是同一个 domain 对象(而不是 dict)。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from otter.core.event import Event, Ref


class StoreError(Exception):
    """存储层异常。"""


# ────────────────────── 领域模型 ──────────────────────


@dataclass
class UpsertResult:
    """upsert_events 的统计结果。"""

    inserted: int = 0
    updated: int = 0
    unchanged: int = 0

    @property
    def total(self) -> int:
        return self.inserted + self.updated + self.unchanged


class CollectorState(BaseModel):
    """每个 collector 的运行状态(cursor / last_error / last_run 等)。"""

    model_config = ConfigDict(extra="forbid")

    source: str
    last_run_at: datetime | None = None
    last_cursor: str | None = None
    last_error: str | None = None
    last_ok_at: datetime | None = None


class Report(BaseModel):
    """一份生成好的日报。"""

    model_config = ConfigDict(extra="forbid")

    date: str  # YYYY-MM-DD(本地日,人类可读)
    content_md: str
    llm_provider: str | None = None
    llm_model: str | None = None
    generated_at: datetime
    event_count: int = 0
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    trace_path: str | None = None


# ────────────────────── 辅助函数 ──────────────────────


def _ts(dt: datetime | None) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return int(dt.astimezone(UTC).timestamp())


def _from_ts(v: int | None) -> datetime | None:
    return None if v is None else datetime.fromtimestamp(v, UTC)


def _event_to_row(e: Event) -> tuple:
    return (
        e.id, e.source, e.type, _ts(e.timestamp), e.actor,
        e.title, e.body, e.url,
        json.dumps([r.model_dump() for r in e.refs], ensure_ascii=False),
        json.dumps(e.metadata, ensure_ascii=False),
        _ts(e.collected_at), e.content_hash,
    )


def _row_to_event(row: sqlite3.Row) -> Event:
    return Event(
        id=row["id"],
        source=row["source"],
        type=row["type"],
        timestamp=_from_ts(row["timestamp"]),
        actor=row["actor"],
        title=row["title"],
        body=row["body"],
        url=row["url"],
        refs=[Ref(**r) for r in json.loads(row["refs_json"] or "[]")],
        metadata=json.loads(row["metadata_json"] or "{}"),
        collected_at=_from_ts(row["collected_at"]),
        content_hash=row["content_hash"],
    )


def _row_to_report(row: sqlite3.Row) -> Report:
    return Report(
        date=row["date"],
        content_md=row["content_md"],
        llm_provider=row["llm_provider"],
        llm_model=row["llm_model"],
        generated_at=_from_ts(row["generated_at"]),
        event_count=row["event_count"] or 0,
        prompt_tokens=row["prompt_tokens"],
        completion_tokens=row["completion_tokens"],
        trace_path=row["trace_path"],
    )


def _discover_migrations() -> list[tuple[int, str, str]]:
    """扫描 otter.migrations 包下的 `NNN_*.sql`,返回 (version, name, sql)。"""
    pkg = files("otter.migrations")
    out: list[tuple[int, str, str]] = []
    for res in sorted(pkg.iterdir(), key=lambda r: r.name):
        name = res.name
        if not name.endswith(".sql"):
            continue
        try:
            version = int(name.split("_", 1)[0])
        except ValueError as e:
            raise StoreError(f"迁移文件名不合法(应为 NNN_*.sql):{name}") from e
        out.append((version, name, res.read_text(encoding="utf-8")))
    return out


# ────────────────────── Store ──────────────────────


_INSERT_EVENT_SQL = """
INSERT INTO events(
    id, source, type, timestamp, actor, title, body, url,
    refs_json, metadata_json, collected_at, content_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""

_UPDATE_EVENT_SQL = """
UPDATE events SET
    source = ?, type = ?, timestamp = ?, actor = ?,
    title = ?, body = ?, url = ?,
    refs_json = ?, metadata_json = ?, collected_at = ?, content_hash = ?
WHERE id = ?
"""


class Store:
    """SQLite 持久化封装。

    典型用法:
        with Store(cfg.data_path() / "otter.db") as store:
            store.migrate()
            store.upsert_events([...])
            events = store.query_events(since, until)
    """

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            self.db_path,
            isolation_level=None,  # autocommit,我们用显式事务
            detect_types=0,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA journal_mode = WAL")

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ────────── 事务 ──────────

    @contextmanager
    def _txn(self) -> Iterator[None]:
        self._conn.execute("BEGIN")
        try:
            yield
            self._conn.execute("COMMIT")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise

    # ────────── 迁移 ──────────

    def migrate(self) -> list[int]:
        """应用所有未运行的迁移,返回本次实际应用的版本号列表。"""
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version ("
            "  version INTEGER PRIMARY KEY,"
            "  applied_at INTEGER NOT NULL"
            ")"
        )
        applied = {
            row["version"]
            for row in self._conn.execute("SELECT version FROM schema_version")
        }
        newly: list[int] = []
        for version, _name, sql in _discover_migrations():
            if version in applied:
                continue
            # 注意:executescript 会自动提交任何开着的事务,不能包在显式事务里。
            # 迁移 SQL 全部用 `CREATE TABLE/INDEX IF NOT EXISTS`,即便在
            # executescript 与 INSERT schema_version 之间崩溃,下次重跑也安全。
            self._conn.executescript(sql)
            self._conn.execute(
                "INSERT INTO schema_version(version, applied_at) VALUES (?, ?)",
                (version, int(datetime.now(UTC).timestamp())),
            )
            newly.append(version)
        return newly

    def schema_version(self) -> int:
        try:
            row = self._conn.execute(
                "SELECT MAX(version) AS v FROM schema_version"
            ).fetchone()
        except sqlite3.OperationalError:
            return 0
        return (row["v"] if row and row["v"] is not None else 0)

    # ────────── Events ──────────

    def upsert_events(self, events: Iterable[Event]) -> UpsertResult:
        """按 id 幂等写入。content_hash 相同 = unchanged;不同 = updated。"""
        result = UpsertResult()
        with self._txn():
            for e in events:
                existing = self._conn.execute(
                    "SELECT content_hash FROM events WHERE id = ?", (e.id,)
                ).fetchone()
                if existing is None:
                    self._conn.execute(_INSERT_EVENT_SQL, _event_to_row(e))
                    result.inserted += 1
                elif existing["content_hash"] == e.content_hash:
                    result.unchanged += 1
                else:
                    row = _event_to_row(e)
                    # UPDATE 的参数顺序:去掉首个 id,末尾补 id 作为 WHERE
                    self._conn.execute(_UPDATE_EVENT_SQL, row[1:] + (row[0],))
                    result.updated += 1
        return result

    def query_events(
        self,
        since: datetime,
        until: datetime,
        source: str | None = None,
    ) -> list[Event]:
        """查询 [since, until) 窗口内事件,按时间升序。"""
        params: list[object] = [_ts(since), _ts(until)]
        sql = "SELECT * FROM events WHERE timestamp >= ? AND timestamp < ?"
        if source is not None:
            sql += " AND source = ?"
            params.append(source)
        sql += " ORDER BY timestamp ASC"
        return [_row_to_event(row) for row in self._conn.execute(sql, params)]

    def event_by_id(self, event_id: str) -> Event | None:
        row = self._conn.execute(
            "SELECT * FROM events WHERE id = ?", (event_id,)
        ).fetchone()
        return _row_to_event(row) if row else None

    def event_count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    # ────────── Collector State ──────────

    def get_collector_state(self, source: str) -> CollectorState | None:
        row = self._conn.execute(
            "SELECT * FROM collector_state WHERE source = ?", (source,)
        ).fetchone()
        if row is None:
            return None
        return CollectorState(
            source=row["source"],
            last_run_at=_from_ts(row["last_run_at"]),
            last_cursor=row["last_cursor"],
            last_error=row["last_error"],
            last_ok_at=_from_ts(row["last_ok_at"]),
        )

    def set_collector_state(self, state: CollectorState) -> None:
        self._conn.execute(
            """
            INSERT INTO collector_state(source, last_run_at, last_cursor, last_error, last_ok_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source) DO UPDATE SET
                last_run_at = excluded.last_run_at,
                last_cursor = excluded.last_cursor,
                last_error  = excluded.last_error,
                last_ok_at  = excluded.last_ok_at
            """,
            (
                state.source,
                _ts(state.last_run_at),
                state.last_cursor,
                state.last_error,
                _ts(state.last_ok_at),
            ),
        )

    def list_collector_states(self) -> list[CollectorState]:
        rows = self._conn.execute(
            "SELECT * FROM collector_state ORDER BY source"
        ).fetchall()
        return [
            CollectorState(
                source=r["source"],
                last_run_at=_from_ts(r["last_run_at"]),
                last_cursor=r["last_cursor"],
                last_error=r["last_error"],
                last_ok_at=_from_ts(r["last_ok_at"]),
            )
            for r in rows
        ]

    # ────────── Reports ──────────

    def save_report(self, report: Report) -> None:
        self._conn.execute(
            """
            INSERT INTO reports(
                date, content_md, llm_provider, llm_model, generated_at,
                event_count, prompt_tokens, completion_tokens, trace_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                content_md        = excluded.content_md,
                llm_provider      = excluded.llm_provider,
                llm_model         = excluded.llm_model,
                generated_at      = excluded.generated_at,
                event_count       = excluded.event_count,
                prompt_tokens     = excluded.prompt_tokens,
                completion_tokens = excluded.completion_tokens,
                trace_path        = excluded.trace_path
            """,
            (
                report.date,
                report.content_md,
                report.llm_provider,
                report.llm_model,
                _ts(report.generated_at),
                report.event_count,
                report.prompt_tokens,
                report.completion_tokens,
                report.trace_path,
            ),
        )

    def get_report(self, date: str) -> Report | None:
        row = self._conn.execute(
            "SELECT * FROM reports WHERE date = ?", (date,)
        ).fetchone()
        return _row_to_report(row) if row else None

    def list_reports(self, limit: int = 10) -> list[Report]:
        rows = self._conn.execute(
            "SELECT * FROM reports ORDER BY date DESC LIMIT ?", (limit,)
        ).fetchall()
        return [_row_to_report(row) for row in rows]
