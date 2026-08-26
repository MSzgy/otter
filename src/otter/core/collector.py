"""Collector 契约 —— 所有采集器都要满足的最小接口。

设计要点(见 docs/ARCHITECTURE.md §4.1):
    - Protocol 而不是基类:第三方插件不需要 import otter 的基类,只要满足
      duck typing;测试也更容易造替身。
    - 依赖注入统一走 kwargs:`config` / `resolver` / `identity`。
      新增 Collector 时缺什么就忽略什么,而不是重新设计构造器签名。
    - `collect(since, until)` 返回 Iterable[Event]:允许生成器,长跑不会撑内存。
    - `name` 作为类变量,兼作 Event.source 字段(`source="git"` 的事件由 name="git"
      的 Collector 生产)。
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any, ClassVar, Protocol, runtime_checkable

from otter.core.event import Event
from otter.core.keychain import SecretResolver


@runtime_checkable
class Collector(Protocol):
    """采集器契约。"""

    name: ClassVar[str]  # 例:"git" / "github";与 Event.source 保持一致

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,
        identity: str,
    ) -> None: ...

    def collect(self, since: datetime, until: datetime) -> Iterable[Event]: ...
