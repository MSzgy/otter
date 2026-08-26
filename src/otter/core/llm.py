"""LLM Provider 契约 —— 所有 LLM 后端满足的最小接口。

设计要点(见 docs/ARCHITECTURE.md §4.2):
    - Protocol 而不是基类,允许非 otter 依赖的第三方实现。
    - `LLMResponse` 是"贫血"DTO,只带足够生成 Report 与写入 llm_traces 的信息。
    - 只有一个 `generate()` 入口,MVP 不做流式;后续要 streaming 时再加
      `stream()` 方法(不影响现有实现)。
    - system prompt 与 user prompt 分开传,便于 Provider 内部按各家 API
      拼装(Anthropic 有独立 system 字段,OpenAI 走 messages[0])。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar, Protocol, runtime_checkable

from otter.core.keychain import SecretResolver


@dataclass
class LLMResponse:
    """一次 LLM 调用的结果。"""

    content: str
    provider: str           # 例:"claude"
    model: str              # 例:"claude-sonnet-4-6"
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


class LLMError(Exception):
    """LLM 相关错误:配置缺失、API 调用失败、响应格式异常等。"""


@runtime_checkable
class LLMProvider(Protocol):
    """LLM 后端契约。"""

    name: ClassVar[str]

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,
    ) -> None: ...

    def generate(
        self,
        prompt: str,
        *,
        system: str | None = None,
    ) -> LLMResponse: ...
