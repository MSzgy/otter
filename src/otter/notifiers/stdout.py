"""StdoutNotifier —— 简报打印到终端。

主要用于:
    - 手动跑 `otter report` 时直接看结果
    - 调试 pipeline
    - 用 shell 管道进一步处理:`otter report | glow` / `... | pbcopy`

Config(全部可选):
    [notifiers.stdout]
    header = true        # 是否打印一行 "# 日报 · {date} ({N} events)" 头(默认 true)
"""

from __future__ import annotations

import sys
from typing import Any, ClassVar

from otter.core.keychain import SecretResolver
from otter.core.store import Report


class StdoutNotifier:
    name: ClassVar[str] = "stdout"

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,  # noqa: ARG002
    ) -> None:
        self._header = bool(config.get("header", True))

    def notify(self, report: Report) -> None:
        if self._header:
            sys.stdout.write(
                f"# 日报 · {report.date}({report.event_count} events)\n\n"
            )
        sys.stdout.write(report.content_md)
        if not report.content_md.endswith("\n"):
            sys.stdout.write("\n")
        sys.stdout.flush()
