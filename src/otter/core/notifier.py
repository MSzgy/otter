"""Notifier 契约 —— 报告生成后的分发插件接口。

设计要点:
    - Notifier 是"生成 Report 后额外做的事":推 stdout / 写额外副本 / 未来推
      webhook / 飞书 / 邮件等。Orchestrator 里已经把 md 落到默认 report_dir,
      Notifier 是**在其之上**的分发。
    - Protocol + name ClassVar,与 Collector/LLMProvider 同风格。
    - `notify(report)` 无返回值;失败抛 NotifierError,由调用方(CLI)决定是记录
      warning 继续还是中断。
"""

from __future__ import annotations

from typing import Any, ClassVar, Protocol, runtime_checkable

from otter.core.keychain import SecretResolver
from otter.core.store import Report


class NotifierError(Exception):
    """通知失败。"""


@runtime_checkable
class Notifier(Protocol):
    """通知器契约。"""

    name: ClassVar[str]

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,
    ) -> None: ...

    def notify(self, report: Report) -> None: ...
