"""Mock Provider —— 离线开发、单测用。返回可预测的固定内容。

作用:
    - 让 orchestrator / notifier / CLI 端到端流程在没有 LLM 密钥时也能跑通
    - 单测里替代真实 LLM,避免网络依赖
    - config 里可覆盖 `response` 得到不同固定文本

注:虽然实现极简,但仍走同一个 LLMProvider 契约。这是 Protocol 抽象的
    价值 —— 上层不知道也不在乎自己在调 Claude 还是 Mock。
"""

from __future__ import annotations

from typing import Any, ClassVar

from otter.core.keychain import SecretResolver
from otter.core.llm import LLMResponse

_DEFAULT_RESPONSE = """# 今日简报(mock)

## 代码提交
- (mock)完成 X

## GitHub 活动
- (mock)review 了 Y

## 邮件与会议
- (mock)回了几封 邮件,开了 1 个会

## 综合总结
- (mock)Z 待续
- (mock)明日继续 Z
"""


class MockProvider:
    """返回固定字符串的 LLM Provider。"""

    name: ClassVar[str] = "mock"

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,  # noqa: ARG002
    ) -> None:
        self._response: str = str(config.get("response") or _DEFAULT_RESPONSE)
        self._model: str = str(config.get("model") or "mock-v1")
        self.calls: list[dict[str, Any]] = []  # 便于测试断言

    def generate(
        self,
        prompt: str,
        *,
        system: str | None = None,
    ) -> LLMResponse:
        self.calls.append({"prompt": prompt, "system": system})
        return LLMResponse(
            content=self._response,
            provider=self.name,
            model=self._model,
            prompt_tokens=len(prompt.split()),
            completion_tokens=len(self._response.split()),
        )
