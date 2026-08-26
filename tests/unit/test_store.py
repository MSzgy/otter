"""Store 层单元测试。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from otter.core.event import Event, Ref
from otter.core.store import (
    CollectorState,
    Report,
    Store,
    UpsertResult,
    _discover_migrations,
)


def _dt(offset_hours: int = 0) -> datetime:
    return datetime(2026, 8, 25, 10, 0, 0, tzinfo=UTC) + timedelta(hours=offset_hours)


def _make_event(source_id: str = "abc", title: str = "commit msg", offset: int = 0) -> Event:
    return Event.build(
        source="git",
        source_id=source_id,
        type="commit",
        timestamp=_dt(offset),
        title=title,
        actor="me@example.com",
        refs=[Ref(kind="repo", id="myorg/myrepo")],
        metadata={"files_changed": 3},
    )


@pytest.fixture
def store(tmp_path: Path):
    s = Store(tmp_path / "otter.db")
    s.migrate()
    yield s
    s.close()


# ─────────────── Migrations ───────────────


class TestMigration:
    def test_migrations_discovered(self) -> None:
        migrations = _discover_migrations()
        assert len(migrations) >= 1
        assert migrations[0][0] == 1
        assert "CREATE TABLE" in migrations[0][2]

    def test_migrate_creates_schema(self, tmp_path: Path) -> None:
        s = Store(tmp_path / "otter.db")
        assert s.schema_version() == 0
        applied = s.migrate()
        assert applied == [1]
        assert s.schema_version() == 1
        s.close()

    def test_migrate_idempotent(self, tmp_path: Path) -> None:
        s = Store(tmp_path / "otter.db")
        s.migrate()
        applied_again = s.migrate()
        assert applied_again == []
        assert s.schema_version() == 1
        s.close()

    def test_migrate_creates_dir(self, tmp_path: Path) -> None:
        db = tmp_path / "nested" / "dir" / "otter.db"
        s = Store(db)
        s.migrate()
        assert db.exists()
        s.close()


# ─────────────── Events ───────────────


class TestUpsertEvents:
    def test_insert(self, store: Store) -> None:
        e = _make_event()
        r = store.upsert_events([e])
        assert r == UpsertResult(inserted=1)
        assert store.event_count() == 1

    def test_unchanged(self, store: Store) -> None:
        e = _make_event()
        store.upsert_events([e])
        r = store.upsert_events([e])
        assert r == UpsertResult(unchanged=1)
        assert store.event_count() == 1

    def test_updated_on_content_change(self, store: Store) -> None:
        e1 = _make_event(title="v1")
        store.upsert_events([e1])
        e2 = _make_event(title="v2")  # 同 id,不同 title → hash 变
        assert e1.id == e2.id
        assert e1.content_hash != e2.content_hash
        r = store.upsert_events([e2])
        assert r == UpsertResult(updated=1)
        assert store.event_count() == 1  # 仍是 1 条,被覆盖

        # 覆盖后 title 应为 v2
        fetched = store.event_by_id(e1.id)
        assert fetched is not None
        assert fetched.title == "v2"

    def test_mixed_batch(self, store: Store) -> None:
        e1 = _make_event(source_id="a")
        e2 = _make_event(source_id="b")
        store.upsert_events([e1, e2])
        e1_updated = _make_event(source_id="a", title="new")
        e3 = _make_event(source_id="c")
        r = store.upsert_events([e1_updated, e2, e3])
        assert r == UpsertResult(inserted=1, updated=1, unchanged=1)
        assert store.event_count() == 3


class TestQueryEvents:
    def test_time_window(self, store: Store) -> None:
        # 3 个事件,分别在 T, T+1h, T+3h
        store.upsert_events([
            _make_event(source_id="a", offset=0),
            _make_event(source_id="b", offset=1),
            _make_event(source_id="c", offset=3),
        ])
        # 窗口 [T+1, T+2) 应只命中 b
        result = store.query_events(_dt(1), _dt(2))
        assert len(result) == 1
        assert result[0].id == "git:b"

        # 窗口 [T, T+4) 应命中全部
        result = store.query_events(_dt(0), _dt(4))
        assert len(result) == 3

    def test_ordered_by_timestamp(self, store: Store) -> None:
        # 乱序插入
        store.upsert_events([
            _make_event(source_id="c", offset=3),
            _make_event(source_id="a", offset=0),
            _make_event(source_id="b", offset=1),
        ])
        result = store.query_events(_dt(-1), _dt(10))
        assert [e.id for e in result] == ["git:a", "git:b", "git:c"]

    def test_source_filter(self, store: Store) -> None:
        store.upsert_events([_make_event(source_id="a")])
        # 手工塞一个不同 source 的
        gh = Event.build(source="github", source_id="1", type="pr",
                         timestamp=_dt(0), title="pr")
        store.upsert_events([gh])
        assert len(store.query_events(_dt(-1), _dt(10), source="git")) == 1
        assert len(store.query_events(_dt(-1), _dt(10), source="github")) == 1
        assert len(store.query_events(_dt(-1), _dt(10))) == 2

    def test_roundtrip_preserves_all_fields(self, store: Store) -> None:
        e = _make_event()
        store.upsert_events([e])
        fetched = store.event_by_id(e.id)
        assert fetched is not None
        # 关键字段全对上
        assert fetched.id == e.id
        assert fetched.source == e.source
        assert fetched.type == e.type
        assert fetched.title == e.title
        assert fetched.actor == e.actor
        assert fetched.timestamp == e.timestamp
        assert fetched.content_hash == e.content_hash
        assert fetched.refs == e.refs
        assert fetched.metadata == e.metadata

    def test_event_by_id_missing(self, store: Store) -> None:
        assert store.event_by_id("no:such:id") is None


# ─────────────── CollectorState ───────────────


class TestCollectorState:
    def test_get_missing(self, store: Store) -> None:
        assert store.get_collector_state("nope") is None

    def test_roundtrip(self, store: Store) -> None:
        state = CollectorState(
            source="git",
            last_run_at=_dt(0),
            last_cursor="cursor-1",
            last_ok_at=_dt(0),
        )
        store.set_collector_state(state)
        fetched = store.get_collector_state("git")
        assert fetched is not None
        assert fetched.source == "git"
        assert fetched.last_cursor == "cursor-1"
        assert fetched.last_run_at == _dt(0)
        assert fetched.last_ok_at == _dt(0)
        assert fetched.last_error is None

    def test_upsert_by_source(self, store: Store) -> None:
        store.set_collector_state(CollectorState(source="git", last_cursor="v1"))
        store.set_collector_state(CollectorState(source="git", last_cursor="v2"))
        fetched = store.get_collector_state("git")
        assert fetched is not None
        assert fetched.last_cursor == "v2"

    def test_list(self, store: Store) -> None:
        store.set_collector_state(CollectorState(source="git"))
        store.set_collector_state(CollectorState(source="github"))
        listed = store.list_collector_states()
        assert [s.source for s in listed] == ["git", "github"]


# ─────────────── Reports ───────────────


class TestReports:
    def _report(self, date: str = "2026-08-25") -> Report:
        return Report(
            date=date,
            content_md=f"# 简报 {date}\n- 事件1",
            llm_provider="claude",
            llm_model="claude-sonnet-4-6",
            generated_at=_dt(0),
            event_count=1,
            prompt_tokens=100,
            completion_tokens=200,
        )

    def test_save_and_get(self, store: Store) -> None:
        r = self._report()
        store.save_report(r)
        fetched = store.get_report("2026-08-25")
        assert fetched is not None
        assert fetched.content_md == r.content_md
        assert fetched.llm_provider == "claude"
        assert fetched.prompt_tokens == 100

    def test_overwrite_same_date(self, store: Store) -> None:
        store.save_report(self._report())
        r2 = self._report()
        r2 = r2.model_copy(update={"content_md": "覆盖后的内容"})
        store.save_report(r2)
        fetched = store.get_report("2026-08-25")
        assert fetched is not None
        assert fetched.content_md == "覆盖后的内容"

    def test_list_desc(self, store: Store) -> None:
        for d in ["2026-08-23", "2026-08-25", "2026-08-24"]:
            store.save_report(self._report(date=d))
        listed = store.list_reports()
        assert [r.date for r in listed] == ["2026-08-25", "2026-08-24", "2026-08-23"]

    def test_get_missing(self, store: Store) -> None:
        assert store.get_report("2099-12-31") is None


# ─────────────── 上下文管理器 ───────────────


class TestContextManager:
    def test_close_via_with(self, tmp_path: Path) -> None:
        with Store(tmp_path / "otter.db") as s:
            s.migrate()
            s.upsert_events([_make_event()])
            assert s.event_count() == 1
        # 关闭后再打开,数据还在
        with Store(tmp_path / "otter.db") as s2:
            assert s2.schema_version() == 1
            assert s2.event_count() == 1
