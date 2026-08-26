"""从 `config/config.toml` 加载并强校验配置。

设计要点(见 ../docs/ARCHITECTURE.md §7):
    - 顶层字段用 pydantic 强 schema(extra="forbid"),catch 拼写错误。
    - 但 collector / llm.<provider> / notifier.<name> 段的**内容**保留为
      dict,交给具体插件自己校验 —— 这是可扩展性的关键,加新插件不改核心。
    - 相对路径以项目根为基准解析。
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from otter.core.paths import project_root, resolve_path

DEFAULT_CONFIG_PATH = "config/config.toml"


class ConfigError(Exception):
    """加载或校验 config.toml 失败。"""


class CoreCfg(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timezone: str = "UTC"
    data_dir: str = "./data"
    report_dir: str = "./reports"
    log_dir: str = "./logs"
    log_level: str = "INFO"


class ScheduleCfg(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    daily_report: str = "0 9 * * *"
    lookback_days: int = 1


class IdentityCfg(BaseModel):
    model_config = ConfigDict(extra="forbid")

    primary: str
    aliases: list[str] = Field(default_factory=list)

    def all_emails(self) -> list[str]:
        return [self.primary, *self.aliases]


class LLMCfg(BaseModel):
    """`[llm]` 段。

    TOML 里 `[llm]` 有一个 `provider` 标量,底下 `[llm.<name>]` 子表就是各
    provider 自己的配置。这里把它们拆开:`provider` 决定用谁,`providers`
    dict 存所有 provider 的原始配置(交给具体 Provider 实现自己解析)。
    """

    model_config = ConfigDict(extra="forbid")

    provider: str
    providers: dict[str, dict[str, Any]] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _extract_providers(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if "providers" in data:  # 已经归一(如测试直接传结构化数据)
            return data
        out: dict[str, Any] = {"providers": {}}
        for k, v in data.items():
            if isinstance(v, dict):
                out["providers"][k] = v
            else:
                out[k] = v
        return out

    def provider_config(self, name: str | None = None) -> dict[str, Any]:
        return self.providers.get(name or self.provider, {})


class _PipelineCfg(BaseModel):
    """通用「pipeline 数组 + 若干具名子配置」结构,给 enrichers/notifiers 复用。"""

    model_config = ConfigDict(extra="forbid")

    pipeline: list[str] = Field(default_factory=list)
    configs: dict[str, dict[str, Any]] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _split(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if "configs" in data:
            return data
        out: dict[str, Any] = {"pipeline": data.get("pipeline", []), "configs": {}}
        for k, v in data.items():
            if k == "pipeline":
                continue
            if isinstance(v, dict):
                out["configs"][k] = v
        return out

    def config_for(self, name: str) -> dict[str, Any]:
        return self.configs.get(name, {})


class EnricherCfg(_PipelineCfg):
    pass


class NotifierCfg(_PipelineCfg):
    pass


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    core: CoreCfg = Field(default_factory=CoreCfg)
    schedule: ScheduleCfg = Field(default_factory=ScheduleCfg)
    identity: IdentityCfg
    llm: LLMCfg
    collectors: dict[str, dict[str, Any]] = Field(default_factory=dict)
    enrichers: EnricherCfg = Field(default_factory=EnricherCfg)
    notifiers: NotifierCfg = Field(default_factory=NotifierCfg)
    prompts: dict[str, str] = Field(default_factory=dict)

    # ── 解析后的绝对路径(相对路径以项目根为基准)──
    def data_path(self) -> Path:
        return resolve_path(self.core.data_dir)

    def report_path(self) -> Path:
        return resolve_path(self.core.report_dir)

    def log_path(self) -> Path:
        return resolve_path(self.core.log_dir)

    def collector_config(self, name: str) -> dict[str, Any]:
        return self.collectors.get(name, {})


def load(path: str | Path | None = None) -> Config:
    """加载并校验 `config.toml`。

    Args:
        path: 显式路径。为 None 时使用 `<project_root>/config/config.toml`。
              相对路径以项目根为基准。

    Raises:
        ConfigError: 文件不存在、TOML 解析失败或 schema 校验失败。
    """
    cfg_path = project_root() / DEFAULT_CONFIG_PATH if path is None else resolve_path(path)

    if not cfg_path.exists():
        raise ConfigError(
            f"配置文件不存在:{cfg_path}\n"
            f"请把 config/config.example.toml 复制为 config/config.toml 后修改。"
        )

    try:
        with cfg_path.open("rb") as f:
            raw = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"config.toml TOML 解析失败:{e}") from e

    try:
        return Config.model_validate(raw)
    except Exception as e:  # pydantic ValidationError 也在此
        raise ConfigError(f"config.toml 校验失败:\n{e}") from e
