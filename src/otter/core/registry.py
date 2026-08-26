"""插件 Registry —— 按 entry_points 组发现和加载插件类。

设计要点(见 docs/ARCHITECTURE.md §4.5):
    - 4 组扩展点:otter.collectors / otter.llm / otter.enrichers / otter.notifiers
    - **懒加载**:enumerate 时不 import,只在真正 `get(name)` 时才 `.load()`。
      这样某个插件的实现坏了不会拖累整个 CLI 启动。
    - `register(name, cls)` 允许程序内直接注册(测试、内联插件、开发中的桩)。
      同名的手工注册会**遮蔽** entry_points 发现的插件。

典型用法:
    from otter.core.registry import COLLECTORS

    cls = COLLECTORS.get("git")           # 懒加载 otter.collectors.git_local:GitLocalCollector
    print(COLLECTORS.names())             # 列出所有可用采集器(不加载)
"""

from __future__ import annotations

from importlib.metadata import EntryPoint, entry_points
from typing import Any, Generic, TypeVar

T = TypeVar("T")


class RegistryError(Exception):
    """插件不存在、或加载失败。"""


class PluginRegistry(Generic[T]):
    """按 entry_points group 发现插件的懒加载注册表。"""

    def __init__(self, group: str) -> None:
        self.group = group
        self._manual: dict[str, type[T]] = {}
        self._loaded: dict[str, type[T]] = {}

    # ── 查询 ──

    def names(self) -> list[str]:
        """所有已知插件名(不 import)。手工注册 ∪ entry_points 发现。"""
        return sorted(set(self._manual) | set(self._entry_points()))

    def __contains__(self, name: str) -> bool:
        return name in self._manual or name in self._entry_points()

    def get(self, name: str) -> type[T]:
        """返回插件类。手工注册优先,其次尝试从 entry_points 懒加载。"""
        if name in self._manual:
            return self._manual[name]
        if name in self._loaded:
            return self._loaded[name]

        eps = self._entry_points()
        if name not in eps:
            raise RegistryError(
                f"插件 {name!r} 未在 group {self.group!r} 中找到。"
                f"可用:{self.names() or '(无)'}"
            )
        try:
            cls = eps[name].load()
        except Exception as e:
            raise RegistryError(
                f"加载插件 {self.group}:{name} 失败:{e}"
            ) from e
        self._loaded[name] = cls
        return cls

    # ── 注册与清理 ──

    def register(self, name: str, cls: type[T]) -> None:
        """程序内直接注册。同名会遮蔽 entry_points 发现的插件。"""
        self._manual[name] = cls

    def unregister(self, name: str) -> None:
        """撤销手工注册(不影响 entry_points 发现的)。"""
        self._manual.pop(name, None)
        self._loaded.pop(name, None)

    def clear(self) -> None:
        """清空手工注册与已加载缓存(测试专用)。"""
        self._manual.clear()
        self._loaded.clear()

    # ── 内部 ──

    def _entry_points(self) -> dict[str, EntryPoint]:
        return {ep.name: ep for ep in entry_points(group=self.group)}

    def entry_point_target(self, name: str) -> str | None:
        """返回 entry_point 的 `module:attr` 字符串,用于 `otter plugins info`。"""
        if name in self._manual:
            cls = self._manual[name]
            return f"{cls.__module__}:{cls.__qualname__}"
        eps = self._entry_points()
        return eps[name].value if name in eps else None


# ────── 4 组预定义 Registry(直接 import 使用)──────
# 注:类型参数 T 目前用 Any 兜底,后续每个插件契约类(Collector Protocol 等)
# 落地时再收窄。

COLLECTORS: PluginRegistry[Any] = PluginRegistry("otter.collectors")
LLM_PROVIDERS: PluginRegistry[Any] = PluginRegistry("otter.llm")
ENRICHERS: PluginRegistry[Any] = PluginRegistry("otter.enrichers")
NOTIFIERS: PluginRegistry[Any] = PluginRegistry("otter.notifiers")


def all_registries() -> dict[str, PluginRegistry[Any]]:
    """`otter plugins list` 用。"""
    return {
        "collectors": COLLECTORS,
        "llm": LLM_PROVIDERS,
        "enrichers": ENRICHERS,
        "notifiers": NOTIFIERS,
    }
