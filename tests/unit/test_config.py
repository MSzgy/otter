"""Config 加载器的单元测试。"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from otter.core.config import Config, ConfigError, load


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(content).lstrip())
    return path


class TestLoad:
    def test_load_example_config(self, tmp_path: Path, monkeypatch) -> None:
        """项目内 config.example.toml 必须可作为合法配置加载。"""
        monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
        from otter.core import paths as p
        p._reset_cache_for_tests()

        example = Path(__file__).resolve().parents[2] / "config" / "config.example.toml"
        assert example.exists(), "config/config.example.toml missing"
        cfg = load(example)
        assert cfg.identity.primary == "guoyang.zou@sap.com"
        assert cfg.llm.provider == "claude"
        assert "claude" in cfg.llm.providers
        assert cfg.llm.provider_config()["model"] == "claude-sonnet-4-6"

    def test_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(ConfigError, match="配置文件不存在"):
            load(tmp_path / "does_not_exist.toml")

    def test_invalid_toml(self, tmp_path: Path) -> None:
        f = _write(tmp_path / "bad.toml", "this is [ not valid TOML")
        with pytest.raises(ConfigError, match="TOML 解析失败"):
            load(f)

    def test_missing_required_identity(self, tmp_path: Path) -> None:
        f = _write(tmp_path / "c.toml", """
            [llm]
            provider = "mock"
        """)
        with pytest.raises(ConfigError, match="校验失败"):
            load(f)

    def test_unknown_top_level_key_rejected(self, tmp_path: Path) -> None:
        f = _write(tmp_path / "c.toml", """
            [identity]
            primary = "me@example.com"
            [llm]
            provider = "mock"
            [oops_typo_section]
            foo = "bar"
        """)
        with pytest.raises(ConfigError):
            load(f)


class TestLLMCfg:
    def test_provider_split(self, tmp_path: Path) -> None:
        f = _write(tmp_path / "c.toml", """
            [identity]
            primary = "me@example.com"
            [llm]
            provider = "claude"
            [llm.claude]
            model = "claude-sonnet-4-6"
            api_key_ref = "keychain:otter/claude"
            [llm.mock]
        """)
        cfg = load(f)
        assert cfg.llm.provider == "claude"
        assert set(cfg.llm.providers.keys()) == {"claude", "mock"}
        assert cfg.llm.provider_config()["model"] == "claude-sonnet-4-6"
        assert cfg.llm.provider_config("mock") == {}


class TestPipelineCfg:
    def test_notifier_pipeline_and_configs(self, tmp_path: Path) -> None:
        f = _write(tmp_path / "c.toml", """
            [identity]
            primary = "me@example.com"
            [llm]
            provider = "mock"
            [notifiers]
            pipeline = ["file", "stdout"]
            [notifiers.file]
            filename_template = "{date}.md"
        """)
        cfg = load(f)
        assert cfg.notifiers.pipeline == ["file", "stdout"]
        assert cfg.notifiers.config_for("file") == {"filename_template": "{date}.md"}
        assert cfg.notifiers.config_for("stdout") == {}


class TestCollectorConfigs:
    def test_arbitrary_collector_config_is_dict(self, tmp_path: Path) -> None:
        f = _write(tmp_path / "c.toml", """
            [identity]
            primary = "me@example.com"
            [llm]
            provider = "mock"
            [collectors.custom_source]
            some_flag = true
            some_list = ["a", "b"]
        """)
        cfg = load(f)
        assert cfg.collector_config("custom_source") == {"some_flag": True, "some_list": ["a", "b"]}
        assert cfg.collector_config("does_not_exist") == {}


class TestPaths:
    def test_relative_paths_resolve_against_project_root(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
        from otter.core import paths as p
        p._reset_cache_for_tests()

        f = _write(tmp_path / "c.toml", """
            [identity]
            primary = "me@example.com"
            [llm]
            provider = "mock"
            [core]
            data_dir = "./data"
        """)
        cfg = load(f)
        assert cfg.data_path() == (tmp_path / "data").resolve()


class TestDefaults:
    def test_minimal_config(self, tmp_path: Path) -> None:
        f = _write(tmp_path / "c.toml", """
            [identity]
            primary = "me@example.com"
            [llm]
            provider = "mock"
        """)
        cfg = load(f)
        assert isinstance(cfg, Config)
        assert cfg.core.timezone == "UTC"
        assert cfg.schedule.enabled is True
        assert cfg.schedule.daily_report == "0 9 * * *"
        assert cfg.enrichers.pipeline == []
        assert cfg.notifiers.pipeline == []
