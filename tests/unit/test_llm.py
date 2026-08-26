"""LLM Provider 单元测试:MockProvider + ClaudeProvider(respx 拦截 httpx)。"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from otter.core.llm import LLMError, LLMProvider, LLMResponse
from otter.llm.claude import ClaudeProvider
from otter.llm.mock import MockProvider


class _FakeResolver:
    def __init__(self, value: str = "sk-fake") -> None:
        self.value = value
        self.calls: list[str] = []

    def resolve(self, ref: str) -> str:
        self.calls.append(ref)
        return self.value


# ─────────────── MockProvider ───────────────


class TestMockProvider:
    def test_default_response(self) -> None:
        p = MockProvider(config={}, resolver=_FakeResolver())
        r = p.generate("hello")
        assert r.provider == "mock"
        assert r.model == "mock-v1"
        assert "简报" in r.content
        assert r.prompt_tokens is not None and r.completion_tokens is not None

    def test_custom_response(self) -> None:
        p = MockProvider(
            config={"response": "custom output", "model": "m2"},
            resolver=_FakeResolver(),
        )
        r = p.generate("prompt")
        assert r.content == "custom output"
        assert r.model == "m2"

    def test_records_calls(self) -> None:
        p = MockProvider(config={}, resolver=_FakeResolver())
        p.generate("hi", system="you are otter")
        assert p.calls == [{"prompt": "hi", "system": "you are otter"}]

    def test_satisfies_protocol(self) -> None:
        p = MockProvider(config={}, resolver=_FakeResolver())
        assert isinstance(p, LLMProvider)


# ─────────────── ClaudeProvider 构造 ───────────────


class TestClaudeConstruction:
    def test_missing_model_raises(self) -> None:
        with pytest.raises(LLMError, match="model 未配置"):
            ClaudeProvider(
                config={"api_key_ref": "env:X"},
                resolver=_FakeResolver(),
            )

    def test_missing_key_raises(self) -> None:
        with pytest.raises(LLMError, match="api_key_ref 未配置"):
            ClaudeProvider(
                config={"model": "claude-sonnet-4-6"},
                resolver=_FakeResolver(),
            )

    def test_resolves_secret_at_init(self) -> None:
        r = _FakeResolver()
        ClaudeProvider(
            config={
                "model": "claude-sonnet-4-6",
                "api_key_ref": "keychain:otter/claude",
            },
            resolver=r,
        )
        assert r.calls == ["keychain:otter/claude"]

    def test_base_url_override(self) -> None:
        p = ClaudeProvider(
            config={
                "model": "claude-sonnet-4-6",
                "api_key_ref": "env:X",
                "base_url": "http://localhost:6655",
            },
            resolver=_FakeResolver(),
        )
        assert p._base_url == "http://localhost:6655"

    def test_satisfies_protocol(self) -> None:
        p = ClaudeProvider(
            config={
                "model": "claude-sonnet-4-6",
                "api_key_ref": "env:X",
            },
            resolver=_FakeResolver(),
        )
        assert isinstance(p, LLMProvider)


# ─────────────── ClaudeProvider 调用 ───────────────


def _make_claude(**overrides) -> ClaudeProvider:
    config: dict[str, Any] = {
        "model": "claude-sonnet-4-6",
        "api_key_ref": "keychain:otter/claude",
        "base_url": "http://localhost:6655",
        **overrides,
    }
    return ClaudeProvider(config=config, resolver=_FakeResolver())


def _anthropic_ok_response(text: str = "hi", model: str = "claude-sonnet-4-6") -> dict:
    return {
        "id": "msg_01",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 12, "output_tokens": 34},
    }


class TestClaudeGenerate:
    @respx.mock
    def test_basic_generate(self) -> None:
        route = respx.post("http://localhost:6655/v1/messages").mock(
            return_value=httpx.Response(200, json=_anthropic_ok_response("hello"))
        )
        p = _make_claude()
        r = p.generate("say hi")
        assert isinstance(r, LLMResponse)
        assert r.content == "hello"
        assert r.provider == "claude"
        assert r.model == "claude-sonnet-4-6"
        assert r.prompt_tokens == 12
        assert r.completion_tokens == 34
        # 请求头与请求体
        req = route.calls[0].request
        assert req.headers["x-api-key"] == "sk-fake"
        assert req.headers["anthropic-version"] == "2023-06-01"
        import json as _json
        body = _json.loads(req.content)
        assert body["model"] == "claude-sonnet-4-6"
        assert body["messages"] == [{"role": "user", "content": "say hi"}]
        assert body["max_tokens"] == 4096
        # 未传 system,也没配 temperature → body 里都不应有
        assert "system" not in body
        assert "temperature" not in body

    @respx.mock
    def test_system_prompt_plain(self) -> None:
        respx.post("http://localhost:6655/v1/messages").mock(
            return_value=httpx.Response(200, json=_anthropic_ok_response())
        )
        p = _make_claude()
        p.generate("hi", system="you are otter")
        req = respx.calls[0].request
        import json as _json
        body = _json.loads(req.content)
        assert body["system"] == "you are otter"

    @respx.mock
    def test_system_with_cache_control(self) -> None:
        respx.post("http://localhost:6655/v1/messages").mock(
            return_value=httpx.Response(200, json=_anthropic_ok_response())
        )
        p = _make_claude(cache_control=True)
        p.generate("hi", system="long system prompt")
        req = respx.calls[0].request
        import json as _json
        body = _json.loads(req.content)
        # 打开 cache_control 后,system 应是 list of block 且带 cache_control marker
        assert isinstance(body["system"], list)
        assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
        assert body["system"][0]["text"] == "long system prompt"

    @respx.mock
    def test_concatenates_multiple_text_blocks(self) -> None:
        resp = _anthropic_ok_response()
        resp["content"] = [
            {"type": "text", "text": "part1"},
            {"type": "text", "text": " part2"},
        ]
        respx.post("http://localhost:6655/v1/messages").mock(
            return_value=httpx.Response(200, json=resp)
        )
        p = _make_claude()
        r = p.generate("x")
        assert r.content == "part1 part2"

    @respx.mock
    def test_no_text_block_raises(self) -> None:
        resp = _anthropic_ok_response()
        resp["content"] = []
        respx.post("http://localhost:6655/v1/messages").mock(
            return_value=httpx.Response(200, json=resp)
        )
        p = _make_claude()
        with pytest.raises(LLMError, match="没有 text block"):
            p.generate("x")

    @respx.mock
    def test_api_error_wrapped(self) -> None:
        respx.post("http://localhost:6655/v1/messages").mock(
            return_value=httpx.Response(
                401,
                json={
                    "type": "error",
                    "error": {"type": "authentication_error",
                              "message": "bad key"},
                },
            )
        )
        p = _make_claude()
        with pytest.raises(LLMError, match="Claude API 401"):
            p.generate("x")

    @respx.mock
    def test_network_error_wrapped(self) -> None:
        respx.post("http://localhost:6655/v1/messages").mock(
            side_effect=httpx.ConnectError("boom")
        )
        p = _make_claude()
        with pytest.raises(LLMError, match="Claude 请求异常"):
            p.generate("x")

    @respx.mock
    def test_temperature_and_max_tokens_override(self) -> None:
        respx.post("http://localhost:6655/v1/messages").mock(
            return_value=httpx.Response(200, json=_anthropic_ok_response())
        )
        p = _make_claude(temperature=0.9, max_tokens=512)
        p.generate("x")
        import json as _json
        body = _json.loads(respx.calls[0].request.content)
        assert body["temperature"] == 0.9
        assert body["max_tokens"] == 512


# ─────────────── entry_point 注册 ───────────────


class TestEntryPoints:
    def test_registered(self) -> None:
        from otter.core.registry import LLM_PROVIDERS

        assert set(LLM_PROVIDERS.names()) >= {"claude", "mock"}
        assert LLM_PROVIDERS.get("claude") is ClaudeProvider
        assert LLM_PROVIDERS.get("mock") is MockProvider
