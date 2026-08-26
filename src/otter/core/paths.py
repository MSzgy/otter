"""项目路径解析。

设计:
    - 所有相对路径以「项目根」为基准展开。
    - 项目根通过向上查找 `pyproject.toml` / `.git` 定位;可用
      `OTTER_PROJECT_ROOT` 环境变量强制覆盖(便于测试与远程部署)。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

_MARKER_FILES = ("pyproject.toml", ".git")


@lru_cache(maxsize=1)
def project_root() -> Path:
    env = os.environ.get("OTTER_PROJECT_ROOT")
    if env:
        return Path(env).expanduser().resolve()

    cur = Path.cwd().resolve()
    for candidate in (cur, *cur.parents):
        for marker in _MARKER_FILES:
            if (candidate / marker).exists():
                return candidate
    return cur


def resolve_path(value: str | os.PathLike[str], base: Path | None = None) -> Path:
    """展开 `~`,若为相对路径则以 `base`(缺省 = 项目根)为基准。"""
    p = Path(os.fspath(value)).expanduser()
    if p.is_absolute():
        return p
    root = base or project_root()
    return (root / p).resolve()


def _reset_cache_for_tests() -> None:
    project_root.cache_clear()
