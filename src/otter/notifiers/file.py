"""FileNotifier —— 把简报副本写到指定路径(iCloud / OneDrive / Obsidian vault 等)。

Orchestrator 已经默认写到 `[core].report_dir`,这个 notifier 是**额外**副本,
路径通常配到同步目录(iCloud / OneDrive / Notion 导入目录 …)。

Config:
    [notifiers.file]
    dir               = "~/Library/Mobile Documents/com~apple~CloudDocs/otter"
    filename_template = "{date}.md"        # 支持 {date} 占位符
    overwrite         = true               # 已存在时是否覆盖(默认 true)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar

from otter.core.keychain import SecretResolver
from otter.core.notifier import NotifierError
from otter.core.store import Report


class FileNotifier:
    name: ClassVar[str] = "file"

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,  # noqa: ARG002 — file notifier 不需要密钥
    ) -> None:
        dir_str = config.get("dir")
        if not dir_str:
            raise NotifierError("notifiers.file.dir 未配置")
        self._dir = Path(str(dir_str)).expanduser()
        self._filename_template = str(config.get("filename_template") or "{date}.md")
        self._overwrite = bool(config.get("overwrite", True))

    def notify(self, report: Report) -> None:
        try:
            filename = self._filename_template.format(date=report.date)
        except KeyError as e:
            raise NotifierError(
                f"filename_template 占位符不支持:{e}(只允许 {{date}})"
            ) from e

        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._dir / filename
        if path.exists() and not self._overwrite:
            raise NotifierError(f"目标文件已存在且 overwrite=false:{path}")

        try:
            path.write_text(report.content_md, encoding="utf-8")
        except OSError as e:
            raise NotifierError(f"写文件失败:{path} — {e}") from e
