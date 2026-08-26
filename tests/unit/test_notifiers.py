"""FileNotifier / StdoutNotifier 单元测试。"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from otter.core.notifier import NotifierError
from otter.core.store import Report
from otter.notifiers.file import FileNotifier
from otter.notifiers.stdout import StdoutNotifier


class _NullResolver:
    def resolve(self, ref: str) -> str:  # noqa: ARG002
        raise AssertionError("notifier 不应该解析密钥")


def _report(date: str = "2026-08-26", content: str = "# 日报\n- 干活") -> Report:
    return Report(
        date=date,
        content_md=content,
        llm_provider="mock",
        llm_model="mock-1",
        generated_at=datetime(2026, 8, 26, 9, 0, tzinfo=UTC),
        event_count=3,
    )


# ────────────────────── FileNotifier ──────────────────────


class TestFileNotifier:
    def test_writes_to_configured_dir(self, tmp_path: Path) -> None:
        n = FileNotifier(
            config={"dir": str(tmp_path)},
            resolver=_NullResolver(),
        )
        r = _report()
        n.notify(r)
        out = tmp_path / "2026-08-26.md"
        assert out.exists()
        assert out.read_text(encoding="utf-8") == r.content_md

    def test_creates_missing_dir(self, tmp_path: Path) -> None:
        target = tmp_path / "sub" / "dir"
        n = FileNotifier(config={"dir": str(target)}, resolver=_NullResolver())
        n.notify(_report())
        assert (target / "2026-08-26.md").exists()

    def test_expands_user_home(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HOME", str(tmp_path))
        n = FileNotifier(config={"dir": "~/otter"}, resolver=_NullResolver())
        n.notify(_report())
        assert (tmp_path / "otter" / "2026-08-26.md").exists()

    def test_filename_template(self, tmp_path: Path) -> None:
        n = FileNotifier(
            config={"dir": str(tmp_path), "filename_template": "report-{date}.markdown"},
            resolver=_NullResolver(),
        )
        n.notify(_report("2026-01-02"))
        assert (tmp_path / "report-2026-01-02.markdown").exists()

    def test_missing_dir_raises(self) -> None:
        with pytest.raises(NotifierError, match="notifiers.file.dir"):
            FileNotifier(config={}, resolver=_NullResolver())

    def test_overwrite_default_true(self, tmp_path: Path) -> None:
        target = tmp_path / "2026-08-26.md"
        target.write_text("旧内容", encoding="utf-8")
        n = FileNotifier(config={"dir": str(tmp_path)}, resolver=_NullResolver())
        n.notify(_report(content="新内容"))
        assert target.read_text(encoding="utf-8") == "新内容"

    def test_overwrite_false_raises_when_exists(self, tmp_path: Path) -> None:
        target = tmp_path / "2026-08-26.md"
        target.write_text("旧", encoding="utf-8")
        n = FileNotifier(
            config={"dir": str(tmp_path), "overwrite": False},
            resolver=_NullResolver(),
        )
        with pytest.raises(NotifierError, match="overwrite=false"):
            n.notify(_report())
        assert target.read_text(encoding="utf-8") == "旧"

    def test_overwrite_false_ok_when_absent(self, tmp_path: Path) -> None:
        n = FileNotifier(
            config={"dir": str(tmp_path), "overwrite": False},
            resolver=_NullResolver(),
        )
        n.notify(_report())
        assert (tmp_path / "2026-08-26.md").exists()

    def test_unsupported_placeholder(self, tmp_path: Path) -> None:
        n = FileNotifier(
            config={"dir": str(tmp_path), "filename_template": "{unknown}.md"},
            resolver=_NullResolver(),
        )
        with pytest.raises(NotifierError, match="占位符"):
            n.notify(_report())


# ────────────────────── StdoutNotifier ──────────────────────


class TestStdoutNotifier:
    def test_prints_content_with_header(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        n = StdoutNotifier(config={}, resolver=_NullResolver())
        n.notify(_report(content="# 简报\n- foo"))
        out = capsys.readouterr().out
        assert "# 日报 · 2026-08-26(3 events)" in out
        assert "# 简报" in out
        assert "- foo" in out

    def test_header_disabled(self, capsys: pytest.CaptureFixture[str]) -> None:
        n = StdoutNotifier(config={"header": False}, resolver=_NullResolver())
        n.notify(_report(content="正文"))
        out = capsys.readouterr().out
        assert "日报 ·" not in out
        assert "正文" in out

    def test_appends_trailing_newline(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        n = StdoutNotifier(config={"header": False}, resolver=_NullResolver())
        n.notify(_report(content="没有换行"))
        out = capsys.readouterr().out
        assert out.endswith("\n")

    def test_preserves_existing_trailing_newline(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        n = StdoutNotifier(config={"header": False}, resolver=_NullResolver())
        n.notify(_report(content="末尾有换行\n"))
        out = capsys.readouterr().out
        assert out == "末尾有换行\n"
