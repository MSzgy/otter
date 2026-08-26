"""本地 Git 采集器 —— 从磁盘上的仓库读 `git log`,输出 commit 事件。

设计要点:
    - 输入 `paths` 支持两种含义:
        * 路径本身是 git 仓库(有 `.git/`)→ 直接扫描
        * 路径是目录 → 递归发现子目录里的仓库(限深度,避免误闯 node_modules)
    - 只读 `git log`,不 fetch、不 pull;远程仓库 vs 本地仓库都能采(因为
      只看本地 refs)。
    - 作者过滤走 `--author=<email>`(git 的 --author 是子串匹配,邮箱形式
      足够精确)。
    - subprocess 每仓库跑一次,失败时跳过并保留错误信息,不拖垮整体。
    - MVP 只取 subject,不取 body(body 通常是模板噪声,想要时后期加)。
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Any, ClassVar

from dateutil import parser as date_parser

from otter.core.event import Event, Ref
from otter.core.keychain import SecretResolver

logger = logging.getLogger(__name__)


# 每个字段之间用 NUL 分隔,每行一个 commit。subject 是单行(git 定义),
# 不会含 \n;可能含 |,所以不用 | 做分隔符。
_LOG_FORMAT = "%H%x00%aI%x00%ae%x00%an%x00%s"


class GitLocalError(Exception):
    """Git 相关错误(git 不在 PATH、仓库损坏等)。"""


class GitLocalCollector:
    """从本地 git 仓库读取 commit,产出 `source="git"` 的 Event。"""

    name: ClassVar[str] = "git"

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,  # noqa: ARG002 — 契约要求,git 不用
        identity: str,
    ) -> None:
        raw_paths = config.get("paths") or []
        if not isinstance(raw_paths, list):
            raise GitLocalError(
                f"collectors.git.paths 应为列表,而不是 {type(raw_paths).__name__}"
            )
        self._paths: list[Path] = [Path(p).expanduser() for p in raw_paths]
        self._author: str = str(config.get("author") or identity)
        self._include_merges: bool = bool(config.get("include_merges", False))
        self._max_depth: int = int(config.get("max_depth", 3))
        self._timeout: int = int(config.get("timeout_sec", 30))

    # ────────── 主流程 ──────────

    def collect(self, since: datetime, until: datetime) -> Iterable[Event]:
        if shutil.which("git") is None:
            raise GitLocalError("找不到 git 命令,请先安装 git 或加入 PATH")
        for repo in self._discover_repos():
            try:
                yield from self._collect_repo(repo, since, until)
            except Exception as e:
                # 单个仓库失败不影响其他仓库
                logger.warning("git collector: 仓库 %s 采集失败:%s", repo, e)

    # ────────── 仓库发现 ──────────

    def _discover_repos(self) -> Iterator[Path]:
        """展开配置路径为具体仓库列表。"""
        seen: set[Path] = set()
        for base in self._paths:
            if not base.exists():
                logger.warning("git collector: 路径不存在,跳过:%s", base)
                continue
            resolved = base.resolve()
            if _is_repo(resolved):
                if resolved not in seen:
                    seen.add(resolved)
                    yield resolved
                continue
            # 目录 → 递归发现
            for repo in _walk_for_repos(resolved, self._max_depth):
                if repo not in seen:
                    seen.add(repo)
                    yield repo

    # ────────── 单仓库采集 ──────────

    def _collect_repo(
        self, repo: Path, since: datetime, until: datetime
    ) -> Iterator[Event]:
        args = [
            "git", "-C", str(repo), "log",
            f"--author={self._author}",
            f"--since={since.isoformat()}",
            f"--until={until.isoformat()}",
            f"--format={_LOG_FORMAT}",
        ]
        if not self._include_merges:
            args.append("--no-merges")

        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=self._timeout,
            check=False,
        )
        if result.returncode != 0:
            raise GitLocalError(
                f"git log 失败(exit={result.returncode}):{result.stderr.strip()}"
            )
        repo_name = repo.name
        for line in result.stdout.splitlines():
            if not line:
                continue
            parts = line.split("\x00")
            if len(parts) != 5:
                logger.debug("git collector: 跳过格式不匹配行:%r", line)
                continue
            sha, iso_date, email, name, subject = parts
            try:
                ts = date_parser.isoparse(iso_date)
            except (ValueError, TypeError):
                logger.debug("git collector: 跳过日期解析失败:%r", iso_date)
                continue
            yield Event.build(
                source=self.name,
                source_id=sha,
                type="commit",
                timestamp=ts,
                actor=email,
                title=subject,
                url=None,
                refs=[
                    Ref(kind="repo", id=repo_name),
                    Ref(kind="commit", id=sha),
                ],
                metadata={
                    "repo_path": str(repo),
                    "author_name": name,
                },
            )


# ────────── 内部工具函数 ──────────


def _is_repo(path: Path) -> bool:
    """`.git` 是目录(常规仓库)或文件(worktree / submodule)都算。"""
    git = path / ".git"
    return git.exists()


# 递归发现时跳过的常见噪声目录
_SKIP_DIRS = frozenset({
    "node_modules", "venv", ".venv", "env", ".env",
    "target", "build", "dist", "__pycache__",
    ".idea", ".vscode",
})


def _walk_for_repos(base: Path, max_depth: int) -> Iterator[Path]:
    """在 base 下最多 max_depth 层内查找 `.git` 目录。找到就不再深入。"""
    if max_depth < 0:
        return
    try:
        children = sorted(base.iterdir())
    except (PermissionError, OSError):
        return
    for child in children:
        if not child.is_dir():
            continue
        if child.name.startswith(".") or child.name in _SKIP_DIRS:
            continue
        if _is_repo(child):
            yield child
            continue  # 找到仓库不再向下钻
        if max_depth > 0:
            yield from _walk_for_repos(child, max_depth - 1)
