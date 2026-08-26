"""插件 Registry 单元测试。

我们不依赖真实 entry_points 发现的插件(那需要装外部包)。
主要测试:register/unregister、get 的路由、names 的合并、错误路径。
entry_points 发现路径用 monkeypatch 替换 `_entry_points` 来验证。
"""

from __future__ import annotations

from importlib.metadata import EntryPoint

import pytest

from otter.core.registry import (
    COLLECTORS,
    LLM_PROVIDERS,
    PluginRegistry,
    RegistryError,
    all_registries,
)


class _FakePlugin:
    """占位插件类。"""

    name = "fake"


class _AnotherPlugin:
    name = "another"


@pytest.fixture
def registry() -> PluginRegistry:
    r: PluginRegistry = PluginRegistry("test.group")
    yield r
    r.clear()


# ─────────────── 手工注册 ───────────────


class TestManualRegistration:
    def test_register_and_get(self, registry: PluginRegistry) -> None:
        registry.register("foo", _FakePlugin)
        assert registry.get("foo") is _FakePlugin

    def test_names_lists_manual(self, registry: PluginRegistry) -> None:
        registry.register("b", _FakePlugin)
        registry.register("a", _AnotherPlugin)
        assert registry.names() == ["a", "b"]  # 排序

    def test_contains(self, registry: PluginRegistry) -> None:
        registry.register("foo", _FakePlugin)
        assert "foo" in registry
        assert "bar" not in registry

    def test_unregister(self, registry: PluginRegistry) -> None:
        registry.register("foo", _FakePlugin)
        registry.unregister("foo")
        assert "foo" not in registry
        with pytest.raises(RegistryError):
            registry.get("foo")

    def test_unregister_missing_ok(self, registry: PluginRegistry) -> None:
        # 撤销不存在的名字不应报错
        registry.unregister("nope")

    def test_missing_get_raises(self, registry: PluginRegistry) -> None:
        with pytest.raises(RegistryError, match="未在 group"):
            registry.get("nope")

    def test_entry_point_target_manual(self, registry: PluginRegistry) -> None:
        registry.register("foo", _FakePlugin)
        target = registry.entry_point_target("foo")
        assert target is not None
        assert "_FakePlugin" in target


# ─────────────── entry_points 发现路径 ───────────────


class TestEntryPoints:
    def _make_ep(self, name: str, value: str, group: str) -> EntryPoint:
        return EntryPoint(name=name, value=value, group=group)

    def test_names_includes_entry_points(
        self, registry: PluginRegistry, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ep = self._make_ep("git", "otter.collectors.git:GitCollector", "test.group")
        monkeypatch.setattr(registry, "_entry_points", lambda: {"git": ep})
        registry.register("mock", _FakePlugin)
        assert registry.names() == ["git", "mock"]

    def test_manual_shadows_entry_point(
        self, registry: PluginRegistry, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ep = self._make_ep("git", "some.module:BadClass", "test.group")
        monkeypatch.setattr(registry, "_entry_points", lambda: {"git": ep})
        registry.register("git", _FakePlugin)
        # 手工注册应遮蔽 entry_points 里的 → 不会尝试 load
        assert registry.get("git") is _FakePlugin

    def test_lazy_load(
        self, registry: PluginRegistry, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 造一个 fake entry_point,其 load() 记录调用次数
        calls = {"n": 0}

        class _EP:
            name = "git"
            value = "fake:target"

            def load(self_):
                calls["n"] += 1
                return _FakePlugin

        monkeypatch.setattr(registry, "_entry_points", lambda: {"git": _EP()})
        # 光 names() / __contains__ 不触发 load
        assert "git" in registry.names()
        assert "git" in registry
        assert calls["n"] == 0

        # get() 才 load
        assert registry.get("git") is _FakePlugin
        assert calls["n"] == 1

        # 再次 get() 走缓存
        assert registry.get("git") is _FakePlugin
        assert calls["n"] == 1

    def test_load_failure_wraps_error(
        self, registry: PluginRegistry, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        class _BadEP:
            name = "bad"

            def load(self_):
                raise ImportError("模块坏了")

        monkeypatch.setattr(registry, "_entry_points", lambda: {"bad": _BadEP()})
        with pytest.raises(RegistryError, match="加载插件"):
            registry.get("bad")

    def test_entry_point_target_from_ep(
        self, registry: PluginRegistry, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ep = self._make_ep("git", "otter.collectors.git:GitCollector", "test.group")
        monkeypatch.setattr(registry, "_entry_points", lambda: {"git": ep})
        assert (
            registry.entry_point_target("git")
            == "otter.collectors.git:GitCollector"
        )

    def test_entry_point_target_missing(self, registry: PluginRegistry) -> None:
        assert registry.entry_point_target("nope") is None


# ─────────────── 全局 Registry 实例 ───────────────


class TestGlobalRegistries:
    def test_all_registries_keys(self) -> None:
        keys = set(all_registries().keys())
        assert keys == {"collectors", "llm", "enrichers", "notifiers"}

    def test_predefined_groups(self) -> None:
        assert COLLECTORS.group == "otter.collectors"
        assert LLM_PROVIDERS.group == "otter.llm"

    def test_register_on_global_and_cleanup(self) -> None:
        try:
            COLLECTORS.register("__test_dummy__", _FakePlugin)
            assert COLLECTORS.get("__test_dummy__") is _FakePlugin
        finally:
            COLLECTORS.unregister("__test_dummy__")
        assert "__test_dummy__" not in COLLECTORS
