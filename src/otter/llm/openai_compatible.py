"""OpenAI-compatible Chat Completions, including local keyless servers."""

from __future__ import annotations

from typing import Any, ClassVar
from urllib.parse import urlsplit, urlunsplit

import httpx

from otter.core.llm import LLMError, LLMResponse


def normalize_base_url(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise LLMError("请填写有效的 API Base URL。")
    if any(ord(char) < 32 for char in value):
        raise LLMError("API 地址不能包含控制字符。")
    try:
        url = urlsplit(value.strip())
        port = url.port
    except ValueError:
        raise LLMError("API 地址格式无效。") from None
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise LLMError("API 地址需为 HTTP(S)，不要包含密钥、查询参数或片段。")
    path = url.path.rstrip("/")
    if path.endswith("/chat/completions"):
        path = path[: -len("/chat/completions")]
    if not path:
        path = "/v1"
    host = url.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    authority = host if port is None else f"{host}:{port}"
    return urlunsplit((url.scheme, authority, path, "", ""))


class OpenAICompatibleProvider:
    name: ClassVar[str] = "openai"

    def __init__(self, *, config: dict[str, Any], resolver):
        self.base_url = normalize_base_url(config.get("base_url", "https://api.openai.com/v1"))
        self.model = str(config.get("model", "")).strip()
        if not self.model or len(self.model) > 200 or any(ord(c) < 32 for c in self.model):
            raise LLMError("请填写有效的模型名称。")
        self.limit_field = config.get("token_limit_field", "max_tokens")
        if self.limit_field not in {"max_tokens", "max_completion_tokens"}:
            raise LLMError("输出限制参数无效。")
        try:
            self.max_tokens = int(config.get("max_tokens", 4096))
            self.timeout = float(config.get("timeout_sec", 60))
        except (ValueError, TypeError):
            raise LLMError("输出长度和超时必须为数字。") from None
        if not 1 <= self.max_tokens <= 131072 or not 1 <= self.timeout <= 300:
            raise LLMError("输出长度应为 1–131072，超时应为 1–300 秒。")
        ref = config.get("api_key_ref")
        self.api_key = resolver.resolve(ref) if ref else None

    def generate(self, prompt: str, *, system: str | None = None) -> LLMResponse:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        headers = {"Content-Type": "application/json", "User-Agent": "otter-assistant"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        try:
            with httpx.Client(timeout=self.timeout, follow_redirects=False) as client:
                response = client.post(
                    f"{self.base_url}/chat/completions",
                    headers=headers,
                    json={
                        "model": self.model,
                        "messages": messages,
                        self.limit_field: self.max_tokens,
                        "stream": False,
                    },
                )
        except httpx.TimeoutException:
            raise LLMError("模型请求超时，请检查服务或增加超时时间。") from None
        except (httpx.HTTPError, ValueError):
            raise LLMError("无法连接模型服务，请检查 API 地址和网络。") from None
        if response.status_code != 200:
            hints = {
                401: "密钥无效或已过期",
                403: "没有访问权限",
                404: "接口路径或模型不存在",
                429: "请求限流或额度不足",
                400: "模型名称或请求参数不兼容",
            }
            hint = hints.get(response.status_code, "服务返回错误，请检查服务状态")
            # Never forward a server body: some proxies echo Authorization or private prompts.
            raise LLMError(f"模型服务 HTTP {response.status_code}：{hint}。")
        try:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(
                    p.get("text", "")
                    for p in content
                    if isinstance(p, dict) and p.get("type") == "text"
                )
            if not isinstance(content, str) or not content.strip():
                raise ValueError()
            usage = data.get("usage") or {}
            return LLMResponse(
                content=content,
                provider=self.name,
                model=self.model,
                prompt_tokens=usage.get("prompt_tokens"),
                completion_tokens=usage.get("completion_tokens"),
            )
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise LLMError(
                "接口未返回有效文本，请确认支持 Chat Completions 或增加输出长度。"
            ) from None
