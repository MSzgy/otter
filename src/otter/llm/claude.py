"""Claude(Anthropic Messages API 兼容)Provider。

设计要点:
    - **不依赖 anthropic SDK**。Messages API 就是简单的 HTTP JSON,直接 httpx
      更稳:
        1. SAP 内部定制过 anthropic 包(用 vendored httpx2),respx 拦不到,
           单测难做。
        2. SDK 顶层参数在不同 fork/版本间漂移(temperature 有时候在,
           有时候不在),用 raw HTTP 反而免于绑死。
        3. Anthropic 兼容代理(LiteLLM / 公司内网 gateway)都实现同一份
           /v1/messages 契约。
    - `base_url` 可覆盖 —— 默认 `https://api.anthropic.com`。
    - `api_key_ref` 走 SecretResolver,不落配置文件。
    - MVP 不做 streaming;想要 streaming 时另加方法,不破坏 LLMProvider 契约。
    - `cache_control` 打开时给 system prompt 挂 ephemeral cache marker。
"""

from __future__ import annotations

import logging
from typing import Any, ClassVar

import httpx

from otter.core.keychain import SecretResolver
from otter.core.llm import LLMError, LLMResponse

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://api.anthropic.com"
_ANTHROPIC_VERSION = "2023-06-01"


class ClaudeProvider:
    """Anthropic Messages API 兼容的 Provider(裸 HTTP 实现)。"""

    name: ClassVar[str] = "claude"

    def __init__(
        self,
        *,
        config: dict[str, Any],
        resolver: SecretResolver,
    ) -> None:
        model = config.get("model")
        if not model:
            raise LLMError("llm.claude.model 未配置")
        api_key_ref = config.get("api_key_ref")
        if not api_key_ref:
            raise LLMError("llm.claude.api_key_ref 未配置")

        self._model: str = str(model)
        self._max_tokens: int = int(config.get("max_tokens", 4096))
        self._temperature: float | None = (
            float(config["temperature"]) if "temperature" in config else None
        )
        self._cache_control: bool = bool(config.get("cache_control", False))
        self._base_url: str = str(
            config.get("base_url") or _DEFAULT_BASE_URL
        ).rstrip("/")
        self._timeout: float = float(config.get("timeout_sec", 60.0))
        self._api_key: str = resolver.resolve(str(api_key_ref))

    def generate(
        self,
        prompt: str,
        *,
        system: str | None = None,
    ) -> LLMResponse:
        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
        if self._temperature is not None:
            body["temperature"] = self._temperature
        if system:
            if self._cache_control:
                body["system"] = [
                    {
                        "type": "text",
                        "text": system,
                        "cache_control": {"type": "ephemeral"},
                    }
                ]
            else:
                body["system"] = system

        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": _ANTHROPIC_VERSION,
            "content-type": "application/json",
            "user-agent": "otter-assistant",
        }
        try:
            with httpx.Client(timeout=self._timeout) as client:
                r = client.post(
                    f"{self._base_url}/v1/messages",
                    json=body,
                    headers=headers,
                )
        except httpx.HTTPError as e:
            raise LLMError(f"Claude 请求异常:{e}") from e

        if r.status_code >= 400:
            raise LLMError(
                f"Claude API {r.status_code}:{_short(r.text)}"
            )
        try:
            data = r.json()
        except ValueError as e:
            raise LLMError(f"Claude 响应不是 JSON:{_short(r.text)}") from e

        return _parse_response(data, fallback_model=self._model)


# ────────── 解析 ──────────


def _parse_response(data: dict[str, Any], *, fallback_model: str) -> LLMResponse:
    blocks = data.get("content") or []
    parts: list[str] = []
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text") or ""
            if text:
                parts.append(text)
    if not parts:
        raise LLMError("Claude 响应中没有 text block")
    usage = data.get("usage") or {}
    return LLMResponse(
        content="".join(parts),
        provider="claude",
        model=str(data.get("model") or fallback_model),
        prompt_tokens=usage.get("input_tokens"),
        completion_tokens=usage.get("output_tokens"),
    )


def _short(s: str, limit: int = 200) -> str:
    return s if len(s) <= limit else s[:limit] + "..."
