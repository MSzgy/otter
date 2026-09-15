import json

import httpx
import pytest
import respx

from otter.application.model_settings import ModelSettings
from otter.core.config import Config
from otter.core.llm import LLMError
from otter.llm.openai_compatible import OpenAICompatibleProvider, normalize_base_url


class Secrets:
    def __init__(self):
        self.values = {}

    def resolve(self, ref):
        return self.values[ref.removeprefix("keychain:")]

    def set_keychain(self, ref, value):
        self.values[ref] = value

    def delete_keychain(self, ref):
        del self.values[ref]


def configuration():
    return Config.model_validate({"identity": {"primary": "demo@local"},
                                  "llm": {"provider": "mock"}})


def draft(**kwargs):
    return {"base_url": "https://llm.example/v1", "model": "my-model",
            "api_key": "test-private-key", "use_api_key": True, **kwargs}


@pytest.mark.parametrize(("value", "expected"), [
    ("https://llm.example", "https://llm.example/v1"),
    ("https://llm.example/v1/", "https://llm.example/v1"),
    ("https://llm.example/api/v2/chat/completions", "https://llm.example/api/v2"),
    ("http://localhost:11434/v1", "http://localhost:11434/v1"),
])
def test_url_normalization(value, expected):
    assert normalize_base_url(value) == expected


@pytest.mark.parametrize("value", ["file:///secret", "https://key@host/v1", "https://host?k=secret",
                                   "https://host/#secret", "https://host:bad", "https://host/\n"])
def test_bad_urls_rejected(value):
    with pytest.raises(LLMError):
        normalize_base_url(value)


@respx.mock
def test_bearer_and_chat_completions():
    secrets = Secrets()
    secrets.values["test/key"] = "my-secret"
    route = respx.post("https://llm.example/v1/chat/completions").mock(return_value=httpx.Response(
        200, json={"choices": [{"message": {"content": "Hello"}}],
                   "usage": {"prompt_tokens": 2, "completion_tokens": 1}}))
    provider = OpenAICompatibleProvider(config={"model": "my-model", "base_url": "https://llm.example",
                                               "api_key_ref": "keychain:test/key",
                                               "token_limit_field": "max_completion_tokens"},
                                        resolver=secrets)
    result = provider.generate("hello", system="system")
    assert result.content == "Hello"
    assert route.calls.last.request.headers["Authorization"] == "Bearer my-secret"
    payload = json.loads(route.calls.last.request.content)
    assert payload["messages"][0]["role"] == "system"
    assert "max_completion_tokens" in payload and "max_tokens" not in payload


@respx.mock
def test_keyless_and_safe_failure():
    route = respx.post("http://localhost:11434/v1/chat/completions").mock(return_value=httpx.Response(
        401, text="SECRET ECHO"))
    provider = OpenAICompatibleProvider(config={"model": "local", "base_url": "http://localhost:11434"},
                                        resolver=Secrets())
    with pytest.raises(LLMError, match="401") as exc:
        provider.generate("private prompt")
    assert "SECRET" not in str(exc.value)
    assert "authorization" not in route.calls.last.request.headers


def test_settings_persist_without_plaintext_and_restore(tmp_path):
    cfg, secrets = configuration(), Secrets()
    path = tmp_path / "models.json"
    settings = ModelSettings(cfg, path, secrets)
    public = settings.save(draft())
    assert public["has_api_key"] and cfg.llm.provider == "openai"
    assert "test-private-key" not in path.read_text()
    assert "test-private-key" not in json.dumps(public)
    settings.save(draft(api_key="", model="another-model"))
    assert len(secrets.values) == 1
    restored = ModelSettings(configuration(), path, secrets)
    assert restored.public()["model"] == "another-model"
    restored.reset()
    assert restored.config.llm.provider == "mock" and not path.exists()


def test_retained_key_never_follows_changed_endpoint(tmp_path):
    settings = ModelSettings(configuration(), tmp_path / "model.json", Secrets())
    settings.save(draft())
    with pytest.raises(LLMError, match="重新输入"):
        settings.prepare(draft(api_key="", base_url="https://other.example/v1"))


def test_save_failure_rolls_back_key_and_active_model(tmp_path, monkeypatch):
    secrets = Secrets()
    settings = ModelSettings(configuration(), tmp_path / "model.json", secrets)

    def fail(_):
        raise OSError("disk failure")

    monkeypatch.setattr(settings, "_persist", fail)
    with pytest.raises(LLMError, match="保存失败"):
        settings.save(draft())
    assert not secrets.values
    assert settings.config.llm.provider == "mock"


@respx.mock
def test_probe_does_not_save_or_use_work_data(tmp_path):
    route = respx.post("https://llm.example/v1/chat/completions").mock(return_value=httpx.Response(
        200, json={"choices": [{"message": {"content": "OK"}}]}))
    secrets = Secrets()
    path = tmp_path / "models.json"
    settings = ModelSettings(configuration(), path, secrets)
    assert settings.test(draft())["ok"]
    assert not secrets.values and not path.exists()
    assert json.loads(route.calls.last.request.content)["messages"] == [
        {"role": "user", "content": "Reply with only OK."}]
