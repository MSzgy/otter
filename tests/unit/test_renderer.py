"""Renderer 单测 —— 覆盖分组、格式化、截断、模板覆盖、时区等。"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from otter.core.event import Event, Ref
from otter.summarizer.renderer import RenderedPrompt, Renderer, RenderError

IDENTITY = "guoyang.zou@sap.com"


def _mk_event(
    *,
    source: str = "git",
    type_: str = "commit",
    ts: datetime,
    title: str = "fix: something",
    actor: str | None = None,
    body: str | None = None,
    refs: list[Ref] | None = None,
    source_id: str = "abc",
) -> Event:
    return Event.build(
        source=source,
        source_id=source_id,
        type=type_,
        timestamp=ts,
        title=title,
        actor=actor,
        body=body,
        refs=refs or [],
    )


# ────────── RenderedPrompt ──────────


def test_rendered_prompt_char_count():
    p = RenderedPrompt(system="abc", user="defgh")
    assert p.combined_char_count() == 8


# ────────── 基本渲染 ──────────


def test_render_daily_basic_groups_by_source():
    r = Renderer()
    events = [
        _mk_event(
            source="git",
            source_id="c1",
            ts=datetime(2026, 8, 25, 6, 30, tzinfo=UTC),
            title="feat: add x",
        ),
        _mk_event(
            source="github",
            source_id="e1",
            type_="pr_review_received",
            ts=datetime(2026, 8, 25, 8, 30, tzinfo=UTC),
            title="alice approved PR #42",
            actor="alice",
        ),
        _mk_event(
            source="git",
            source_id="c2",
            ts=datetime(2026, 8, 25, 2, 5, tzinfo=UTC),
            title="fix: bug",
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    assert isinstance(out, RenderedPrompt)
    # system 应包含 identity
    assert IDENTITY in out.system
    # 现在的输出规范:按来源分段 + 末尾一段综合总结
    assert "综合总结" in out.system
    for src_name in ("代码提交", "GitHub 活动", "邮件与会议"):
        assert src_name in out.system

    # user 部分:头部字段
    assert "2026-08-25" in out.user
    assert "周二" in out.user  # 2026-08-25 是星期二
    assert "Asia/Shanghai" in out.user
    assert "事件总数:3" in out.user

    # 两个 source 各自的 header
    assert "## 来源:git(2 条)" in out.user
    assert "## 来源:github(1 条)" in out.user

    # git 组内按时间排序:02:05 UTC → 10:05 CST 应在 06:30 UTC → 14:30 CST 前
    idx_early = out.user.index("fix: bug")
    idx_late = out.user.index("feat: add x")
    assert idx_early < idx_late


def test_render_daily_empty_events():
    r = Renderer()
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=[],
    )
    assert "事件总数:0" in out.user
    assert "(窗口内无事件)" in out.user


# ────────── 时区与工作日 ──────────


def test_timezone_conversion_to_shanghai():
    r = Renderer()
    # 00:00 UTC → 08:00 Asia/Shanghai
    events = [
        _mk_event(
            source="git",
            source_id="c1",
            ts=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
            title="early commit",
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    assert "[08:00]" in out.user


def test_invalid_timezone_raises():
    r = Renderer()
    with pytest.raises(RenderError, match="未知的时区"):
        r.render_daily(
            date="2026-08-25",
            timezone="Not/A_Zone",
            identity=IDENTITY,
            since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
            until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
            events=[],
        )


@pytest.mark.parametrize(
    "date_str,expected_wd",
    [
        ("2026-08-24", "周一"),
        ("2026-08-25", "周二"),
        ("2026-08-26", "周三"),
        ("2026-08-30", "周日"),
    ],
)
def test_weekday_chinese(date_str: str, expected_wd: str):
    r = Renderer()
    out = r.render_daily(
        date=date_str,
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=[],
    )
    assert expected_wd in out.user


# ────────── actor / refs / body ──────────


def test_actor_shown_only_when_different_from_identity():
    r = Renderer()
    events = [
        _mk_event(
            source="github",
            source_id="e1",
            type_="pr_review_received",
            ts=datetime(2026, 8, 25, 6, 0, tzinfo=UTC),
            title="alice reviewed",
            actor="alice",
        ),
        _mk_event(
            source="git",
            source_id="c1",
            ts=datetime(2026, 8, 25, 7, 0, tzinfo=UTC),
            title="my own commit",
            actor=IDENTITY,
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    assert "by **alice**" in out.user
    # 自己的事件不应出现 by 自己
    my_line = [line for line in out.user.splitlines() if "my own commit" in line][0]
    assert "by **" not in my_line


def test_refs_rendered_with_optional_label():
    r = Renderer()
    events = [
        _mk_event(
            source="github",
            source_id="e1",
            type_="pr_review_received",
            ts=datetime(2026, 8, 25, 6, 0, tzinfo=UTC),
            title="review",
            actor="bob",
            refs=[
                Ref(kind="repo", id="org/nestor"),
                Ref(kind="pr", id="org/nestor#42", label="casImportOption"),
            ],
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    assert "repo=org/nestor" in out.user
    assert "pr=org/nestor#42 (casImportOption)" in out.user


def test_refs_truncated_by_config():
    r = Renderer(config={"refs_per_event_max": 2})
    events = [
        _mk_event(
            source="git",
            source_id="c1",
            ts=datetime(2026, 8, 25, 6, 0, tzinfo=UTC),
            title="lots of refs",
            refs=[
                Ref(kind="repo", id="r"),
                Ref(kind="pr", id="p1"),
                Ref(kind="pr", id="p2"),
                Ref(kind="commit", id="cccc"),
            ],
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    assert "repo=r" in out.user
    assert "pr=p1" in out.user
    # 第三/四个 ref 不应出现
    assert "pr=p2" not in out.user
    assert "commit=cccc" not in out.user


def test_body_truncated_with_ellipsis():
    r = Renderer(config={"body_maxlen": 20})
    long_body = "x" * 100
    events = [
        _mk_event(
            source="git",
            source_id="c1",
            ts=datetime(2026, 8, 25, 6, 0, tzinfo=UTC),
            title="long body",
            body=long_body,
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    assert "…(略)" in out.user
    # 完整的 100 个 x 不应出现
    assert "x" * 100 not in out.user


def test_multiline_body_flattened_to_single_line():
    r = Renderer()
    events = [
        _mk_event(
            source="git",
            source_id="c1",
            ts=datetime(2026, 8, 25, 6, 0, tzinfo=UTC),
            title="multi",
            body="line1\nline2\nline3",
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    # 找到引用行
    body_lines = [line for line in out.user.splitlines() if line.strip().startswith("> ")]
    assert body_lines
    assert "line1 line2 line3" in body_lines[0]


def test_event_without_body_no_quote_line():
    r = Renderer()
    events = [
        _mk_event(
            source="git",
            source_id="c1",
            ts=datetime(2026, 8, 25, 6, 0, tzinfo=UTC),
            title="no body",
            body=None,
        ),
    ]
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=events,
    )
    assert "> " not in out.user


# ────────── 模板覆盖 ──────────


def test_template_override_from_config(tmp_path: Path):
    sys_tmpl = tmp_path / "custom_sys.j2"
    sys_tmpl.write_text("CUSTOM SYS FOR {{ identity }}", encoding="utf-8")
    user_tmpl = tmp_path / "custom_user.j2"
    user_tmpl.write_text("CUSTOM USER {{ date }} count={{ event_count }}", encoding="utf-8")

    r = Renderer(
        config={
            "daily_system": str(sys_tmpl),
            "daily_user": str(user_tmpl),
        }
    )
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=[],
    )
    assert out.system == f"CUSTOM SYS FOR {IDENTITY}"
    assert out.user == "CUSTOM USER 2026-08-25 count=0"


def test_template_override_relative_path(tmp_path: Path):
    sub = tmp_path / "prompts"
    sub.mkdir()
    (sub / "s.j2").write_text("S {{ identity }}", encoding="utf-8")
    (sub / "u.j2").write_text("U {{ date }}", encoding="utf-8")

    r = Renderer(
        config={"daily_system": "prompts/s.j2", "daily_user": "prompts/u.j2"},
        project_root=tmp_path,
    )
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=[],
    )
    assert out.system == f"S {IDENTITY}"
    assert out.user == "U 2026-08-25"


def test_missing_override_template_raises(tmp_path: Path):
    r = Renderer(
        config={"daily_system": str(tmp_path / "nope.j2")},
        project_root=tmp_path,
    )
    with pytest.raises(RenderError, match="prompt 模板不存在"):
        r.render_daily(
            date="2026-08-25",
            timezone="Asia/Shanghai",
            identity=IDENTITY,
            since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
            until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
            events=[],
        )


# ────────── 窗口时间字段 ──────────


def test_window_start_end_in_local_tz():
    r = Renderer()
    out = r.render_daily(
        date="2026-08-25",
        timezone="Asia/Shanghai",
        identity=IDENTITY,
        # 00:00 UTC = 08:00 上海
        since=datetime(2026, 8, 25, 0, 0, tzinfo=UTC),
        until=datetime(2026, 8, 26, 0, 0, tzinfo=UTC),
        events=[],
    )
    assert "2026-08-25 08:00" in out.user
    assert "2026-08-26 08:00" in out.user
