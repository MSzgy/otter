"""GitLocalCollector 单元测试。

策略:在 tmp_path 里造真实的 git 仓库,跑真的 `git` 命令。
这样能捕捉到参数拼接、format 解析、错误路径的 bug。
如果机器上没有 git,整个模块跳过。
"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from otter.collectors.git_local import GitLocalCollector, GitLocalError

pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="需要 git 命令"
)


# ─────────────── Fixtures ───────────────


def _run(cwd: Path, *args: str, env_extra: dict | None = None) -> None:
    env = None
    if env_extra:
        import os
        env = {**os.environ, **env_extra}
    subprocess.run(
        args, cwd=cwd, env=env, check=True, capture_output=True
    )


def _make_commit(
    repo: Path,
    message: str,
    when: datetime,
    author: str = "Test User <test@example.com>",
    filename: str = "a.txt",
    content: str | None = None,
) -> None:
    """在 repo 里造一个 commit。when 必须 tz-aware。"""
    (repo / filename).write_text(content if content is not None else message)
    _run(repo, "git", "add", filename)
    iso = when.isoformat()
    _run(
        repo,
        "git", "commit", "-m", message,
        "--author", author,
        "--date", iso,
        env_extra={
            "GIT_COMMITTER_DATE": iso,
            # 提交者用一个稳定身份,避免机器全局 git config 干扰
            "GIT_COMMITTER_NAME": "Committer",
            "GIT_COMMITTER_EMAIL": "committer@example.com",
        },
    )


@pytest.fixture
def make_repo(tmp_path: Path) -> Callable[[str], Path]:
    """工厂:make_repo("foo") → tmp_path/foo,已 git init。"""
    def _make(name: str) -> Path:
        repo = tmp_path / name
        repo.mkdir(parents=True)
        _run(repo, "git", "init", "-q", "-b", "main")
        _run(repo, "git", "config", "user.name", "Local")
        _run(repo, "git", "config", "user.email", "local@example.com")
        return repo
    return _make


def _make_collector(paths: list[Path], **overrides) -> GitLocalCollector:
    config = {"paths": [str(p) for p in paths], **overrides}
    return GitLocalCollector(
        config=config,
        resolver=None,  # 契约要求但 git 不用
        identity="me@example.com",
    )


def _dt(hours: int = 0) -> datetime:
    return datetime(2026, 8, 20, 10, 0, tzinfo=UTC) + timedelta(hours=hours)


# ─────────────── 基本采集 ───────────────


class TestBasicCollect:
    def test_single_commit(
        self, make_repo: Callable[[str], Path]
    ) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "first commit", _dt(0),
                     author="Me <me@example.com>")

        c = _make_collector([repo])
        events = list(c.collect(_dt(-1), _dt(1)))

        assert len(events) == 1
        e = events[0]
        assert e.source == "git"
        assert e.type == "commit"
        assert e.title == "first commit"
        assert e.actor == "me@example.com"
        assert e.timestamp == _dt(0)
        # refs 里应有 repo 与 commit
        kinds = {r.kind for r in e.refs}
        assert kinds == {"repo", "commit"}
        # metadata 保留 repo_path 与 author_name
        assert e.metadata["repo_path"] == str(repo.resolve())
        assert e.metadata["author_name"] == "Me"

    def test_author_filter(self, make_repo: Callable[[str], Path]) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "mine", _dt(0),
                     author="Me <me@example.com>", filename="a.txt")
        _make_commit(repo, "theirs", _dt(1),
                     author="Other <other@example.com>", filename="b.txt")

        events = list(_make_collector([repo]).collect(_dt(-1), _dt(2)))
        assert [e.title for e in events] == ["mine"]

    def test_time_window(self, make_repo: Callable[[str], Path]) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "old", _dt(-5),
                     author="Me <me@example.com>", filename="a.txt")
        _make_commit(repo, "in-window", _dt(0),
                     author="Me <me@example.com>", filename="b.txt")
        _make_commit(repo, "future", _dt(5),
                     author="Me <me@example.com>", filename="c.txt")

        events = list(_make_collector([repo]).collect(_dt(-1), _dt(1)))
        assert [e.title for e in events] == ["in-window"]

    def test_merges_excluded_by_default(
        self, make_repo: Callable[[str], Path]
    ) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "base", _dt(0),
                     author="Me <me@example.com>", filename="a.txt")
        _run(repo, "git", "checkout", "-q", "-b", "feature")
        _make_commit(repo, "feat", _dt(1),
                     author="Me <me@example.com>", filename="b.txt")
        _run(repo, "git", "checkout", "-q", "main")
        _make_commit(repo, "on-main", _dt(2),
                     author="Me <me@example.com>", filename="c.txt")
        # 制造一个 merge commit(git merge 不支持 --author,用 env 变量)
        _run(
            repo,
            "git", "merge", "--no-ff", "-m", "merge feature", "feature",
            env_extra={
                "GIT_AUTHOR_NAME": "Me",
                "GIT_AUTHOR_EMAIL": "me@example.com",
                "GIT_AUTHOR_DATE": _dt(3).isoformat(),
                "GIT_COMMITTER_NAME": "Me",
                "GIT_COMMITTER_EMAIL": "me@example.com",
                "GIT_COMMITTER_DATE": _dt(3).isoformat(),
            },
        )

        default_titles = {
            e.title
            for e in _make_collector([repo]).collect(_dt(-1), _dt(3))
        }
        assert "merge feature" not in default_titles

        with_merges = {
            e.title
            for e in _make_collector([repo], include_merges=True).collect(
                _dt(-1), _dt(3)
            )
        }
        assert "merge feature" in with_merges


# ─────────────── 仓库发现 ───────────────


class TestRepoDiscovery:
    def test_direct_repo_path(self, make_repo: Callable[[str], Path]) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "hi", _dt(0), author="Me <me@example.com>")
        events = list(_make_collector([repo]).collect(_dt(-1), _dt(1)))
        assert len(events) == 1

    def test_parent_directory_discovers_children(
        self, tmp_path: Path, make_repo: Callable[[str], Path]
    ) -> None:
        # tmp_path/{repoA, repoB, notgit}
        a = make_repo("repoA")
        b = make_repo("repoB")
        (tmp_path / "notgit").mkdir()
        _make_commit(a, "in A", _dt(0), author="Me <me@example.com>")
        _make_commit(b, "in B", _dt(1), author="Me <me@example.com>")

        events = list(_make_collector([tmp_path]).collect(_dt(-1), _dt(2)))
        titles = sorted(e.title for e in events)
        assert titles == ["in A", "in B"]

    def test_missing_path_skipped(
        self, tmp_path: Path, make_repo: Callable[[str], Path]
    ) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "ok", _dt(0), author="Me <me@example.com>")
        # 混一个不存在的路径,不应炸
        events = list(
            _make_collector([tmp_path / "does-not-exist", repo]).collect(
                _dt(-1), _dt(1)
            )
        )
        assert len(events) == 1

    def test_skip_noise_dirs(
        self, tmp_path: Path, make_repo: Callable[[str], Path]
    ) -> None:
        # 造一个 node_modules 里的伪仓库,不应被采
        nm = tmp_path / "project" / "node_modules" / "pkg"
        nm.mkdir(parents=True)
        _run(nm, "git", "init", "-q", "-b", "main")
        _run(nm, "git", "config", "user.name", "X")
        _run(nm, "git", "config", "user.email", "x@x.com")
        _make_commit(nm, "should not appear", _dt(0),
                     author="Me <me@example.com>")

        # 真仓库在同一 tmp_path 里
        real = make_repo("real")
        _make_commit(real, "real one", _dt(0),
                     author="Me <me@example.com>")

        events = list(_make_collector([tmp_path]).collect(_dt(-1), _dt(1)))
        titles = {e.title for e in events}
        assert titles == {"real one"}

    def test_dedupe_repeated_paths(
        self, make_repo: Callable[[str], Path]
    ) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "once", _dt(0), author="Me <me@example.com>")
        # 同一个仓库路径重复出现,只应采一次
        events = list(_make_collector([repo, repo]).collect(_dt(-1), _dt(1)))
        assert len(events) == 1


# ─────────────── 构造与错误 ───────────────


class TestConstruction:
    def test_default_author_uses_identity(self) -> None:
        c = GitLocalCollector(
            config={"paths": []}, resolver=None, identity="me@example.com"
        )
        assert c._author == "me@example.com"

    def test_author_override(self) -> None:
        c = GitLocalCollector(
            config={"paths": [], "author": "other@sap.com"},
            resolver=None,
            identity="me@example.com",
        )
        assert c._author == "other@sap.com"

    def test_paths_must_be_list(self) -> None:
        with pytest.raises(GitLocalError, match="应为列表"):
            GitLocalCollector(
                config={"paths": "/tmp/repo"},
                resolver=None,
                identity="me@example.com",
            )

    def test_empty_paths_yields_nothing(self) -> None:
        c = _make_collector([])
        assert list(c.collect(_dt(-1), _dt(1))) == []


class TestErrorHandling:
    def test_broken_repo_isolated(
        self, tmp_path: Path, make_repo: Callable[[str], Path]
    ) -> None:
        # 一个正常仓库
        good = make_repo("good")
        _make_commit(good, "ok", _dt(0), author="Me <me@example.com>")
        # 一个假仓库:.git 存在但没内容,git log 会失败
        bad = tmp_path / "bad"
        bad.mkdir()
        (bad / ".git").mkdir()
        # 显式当作路径给进去,而不是父目录发现 —— 我们要测“坏仓库失败不影响好的”
        events = list(_make_collector([good, bad]).collect(_dt(-1), _dt(1)))
        assert len(events) == 1
        assert events[0].title == "ok"


# ─────────────── 契约兼容性 ───────────────


class TestContract:
    def test_satisfies_collector_protocol(self) -> None:
        from otter.core.collector import Collector

        # runtime_checkable Protocol 允许 isinstance 检查
        c = _make_collector([])
        assert isinstance(c, Collector)

    def test_name_matches_source(
        self, make_repo: Callable[[str], Path]
    ) -> None:
        repo = make_repo("r1")
        _make_commit(repo, "x", _dt(0), author="Me <me@example.com>")
        events = list(_make_collector([repo]).collect(_dt(-1), _dt(1)))
        assert events[0].source == GitLocalCollector.name == "git"


# ─────────────── entry_point 注册 ───────────────


class TestEntryPoint:
    def test_registered_in_registry(self) -> None:
        from otter.core.registry import COLLECTORS

        assert "git" in COLLECTORS.names()
        cls = COLLECTORS.get("git")
        assert cls is GitLocalCollector
