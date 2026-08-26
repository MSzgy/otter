"""Event 模型的单元测试。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from otter.core.event import Event, Ref, compute_content_hash


def _dt(offset_hours: int = 0) -> datetime:
    return datetime(2026, 8, 25, 10, 0, 0, tzinfo=timezone(timedelta(hours=offset_hours)))


class TestEventBuild:
    def test_id_format(self) -> None:
        e = Event.build(
            source="github",
            source_id="12345",
            type="PullRequestEvent",
            timestamp=_dt(0),
            title="Open PR #42",
        )
        assert e.id == "github:12345"

    def test_content_hash_stable(self) -> None:
        args = dict(
            source="git", source_id="abc", type="commit",
            timestamp=_dt(0), title="feat: X", body="detail",
        )
        e1 = Event.build(**args)
        e2 = Event.build(**args)
        assert e1.content_hash == e2.content_hash
        assert len(e1.content_hash) == 16

    def test_content_hash_changes_on_title(self) -> None:
        base = dict(source="git", source_id="abc", type="commit", timestamp=_dt(0))
        e1 = Event.build(**base, title="one")
        e2 = Event.build(**base, title="two")
        assert e1.content_hash != e2.content_hash

    def test_content_hash_tz_normalized(self) -> None:
        """+08 与 +00(等价 UTC 时刻)应产生一致的 hash。"""
        h1 = compute_content_hash("git", "commit", _dt(0), "x", None)
        # 同一 UTC 时刻,但表示为 +08(即本地 18:00,UTC 10:00)
        eq_dt = datetime(2026, 8, 25, 18, 0, 0, tzinfo=timezone(timedelta(hours=8)))
        h2 = compute_content_hash("git", "commit", eq_dt, "x", None)
        assert h1 == h2

    def test_defaults(self) -> None:
        e = Event.build(
            source="git", source_id="abc", type="commit",
            timestamp=_dt(0), title="x",
        )
        assert e.actor is None
        assert e.body is None
        assert e.url is None
        assert e.refs == []
        assert e.metadata == {}
        assert e.collected_at.tzinfo is UTC

    def test_utc_normalization(self) -> None:
        cn = _dt(8)  # 2026-08-25 10:00 +08
        e = Event.build(source="git", source_id="a", type="c", timestamp=cn, title="x")
        assert e.timestamp.tzinfo is UTC
        assert e.timestamp.hour == 2  # 10:00 +08 == 02:00 UTC


class TestEventValidation:
    def test_naive_datetime_rejected(self) -> None:
        # build() 会先跑 _to_utc(ValueError),Event() 直接构造走 pydantic(ValidationError)。
        with pytest.raises((ValueError, ValidationError)):
            Event.build(
                source="git", source_id="a", type="c",
                timestamp=datetime(2026, 1, 1, 12, 0),  # naive!
                title="x",
            )

    def test_forbid_extra_fields(self) -> None:
        with pytest.raises(ValidationError):
            Event(
                id="git:x", source="git", type="c",
                timestamp=_dt(0), title="x",
                collected_at=_dt(0), content_hash="abc",
                unknown_field="oops",  # type: ignore[call-arg]
            )


class TestRef:
    def test_basic(self) -> None:
        r = Ref(kind="pr", id="org/repo#42", label="Fix bug")
        assert r.kind == "pr"
        assert r.label == "Fix bug"

    def test_forbid_extra(self) -> None:
        with pytest.raises(ValidationError):
            Ref(kind="pr", id="x", extra="y")  # type: ignore[call-arg]
