"""路径解析的单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from otter.core import paths


@pytest.fixture(autouse=True)
def _reset() -> None:
    paths._reset_cache_for_tests()
    yield
    paths._reset_cache_for_tests()


def test_project_root_uses_env_override(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
    paths._reset_cache_for_tests()
    assert paths.project_root() == tmp_path.resolve()


def test_project_root_walks_up_to_pyproject(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("OTTER_PROJECT_ROOT", raising=False)
    (tmp_path / "pyproject.toml").write_text("")
    nested = tmp_path / "a" / "b" / "c"
    nested.mkdir(parents=True)
    monkeypatch.chdir(nested)
    paths._reset_cache_for_tests()
    assert paths.project_root() == tmp_path.resolve()


def test_resolve_path_expands_tilde() -> None:
    home = Path.home()
    assert paths.resolve_path("~/foo") == home / "foo"


def test_resolve_path_relative_uses_project_root(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
    paths._reset_cache_for_tests()
    assert paths.resolve_path("./data") == (tmp_path / "data").resolve()


def test_resolve_path_absolute_untouched(tmp_path: Path) -> None:
    assert paths.resolve_path(str(tmp_path)) == tmp_path.resolve()
