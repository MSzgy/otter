"""Workspace-scoped desktop model overrides; secret values never enter JSON."""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import uuid
from pathlib import Path

from otter.core.config import Config, LLMCfg
from otter.core.keychain import DefaultSecretResolver
from otter.core.llm import LLMError
from otter.llm.openai_compatible import OpenAICompatibleProvider, normalize_base_url


class ModelSettings:
    def __init__(self, config: Config, path: Path | None, resolver=None):
        self.config = config
        self.original = config.llm.model_copy(deep=True)
        self.path = path
        self.resolver = resolver or DefaultSecretResolver()
        if path and path.exists():
            self.config.llm = LLMCfg.model_validate(json.loads(path.read_text(encoding="utf-8")))

    def public(self) -> dict:
        cfg = self.config.llm.provider_config("openai")
        return {
            "provider": self.config.llm.provider,
            "model": cfg.get("model", ""),
            "base_url": cfg.get("base_url", "https://api.openai.com/v1"),
            "has_api_key": bool(cfg.get("api_key_ref")),
            "max_tokens": cfg.get("max_tokens", 4096),
            "timeout_sec": cfg.get("timeout_sec", 60),
            "token_limit_field": cfg.get("token_limit_field", "max_tokens"),
            "overridden": bool(self.path and self.path.exists()),
        }

    def prepare(self, params: dict) -> tuple[dict, str | None]:
        cfg = {
            k: params[k]
            for k in ("model", "base_url", "max_tokens", "timeout_sec", "token_limit_field")
            if k in params
        }
        cfg["base_url"] = normalize_base_url(cfg.get("base_url", ""))
        key = params.get("api_key", "")
        use_key = params.get("use_api_key", True)
        if not isinstance(key, str) or len(key) > 4096 or not isinstance(use_key, bool):
            raise LLMError("密钥参数无效。")
        key = key.strip()
        if key and any(ord(c) < 32 for c in key):
            raise LLMError("密钥不能包含换行或控制字符。")
        if use_key and not key:
            old = self.config.llm.provider_config("openai")
            if (
                not old.get("api_key_ref")
                or normalize_base_url(old.get("base_url", "")) != cfg["base_url"]
            ):
                raise LLMError("请输入 API Key；更换服务地址时需重新输入，或关闭密钥认证。")
            cfg["api_key_ref"] = old["api_key_ref"]
        if not use_key:
            key = ""
        # Validate all provider fields without writing credentials or making a request.
        validation = dict(cfg)
        validation.pop("api_key_ref", None)
        OpenAICompatibleProvider(config=validation, resolver=self.resolver)
        return cfg, key or None

    def test(self, params: dict) -> dict:
        cfg, key = self.prepare(params)
        cfg = dict(cfg)
        # Bound the connection probe and never use work records or report tracing.
        cfg["timeout_sec"] = min(float(cfg.get("timeout_sec", 60)), 15)
        if key:
            cfg["api_key_ref"] = "draft:key"
        parent = self.resolver

        class DraftResolver:
            def resolve(self, ref):
                return key if ref == "draft:key" else parent.resolve(ref)

        OpenAICompatibleProvider(config=cfg, resolver=DraftResolver()).generate(
            "Reply with only OK."
        )
        return {"ok": True, "message": "连接成功，模型已返回文本。"}

    def _persist(self, llm: LLMCfg) -> None:
        if not self.path:
            raise LLMError("当前运行方式未设置桌面模型存储目录。")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", delete=False, dir=self.path.parent
            ) as stream:
                tmp = Path(stream.name)
                json.dump(llm.model_dump(), stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            tmp.replace(self.path)
        finally:
            if tmp:
                tmp.unlink(missing_ok=True)

    def save(self, params: dict) -> dict:
        cfg, key = self.prepare(params)
        # Only retain the selected override, not other providers' arbitrary config fields.
        owned_ref = None
        try:
            if key:
                owned_ref = f"otter-desktop/model-{uuid.uuid4().hex}"
                self.resolver.set_keychain(owned_ref, key)
                cfg["api_key_ref"] = f"keychain:{owned_ref}"
            llm = LLMCfg(provider="openai", providers={"openai": cfg})
            self._persist(llm)
        except Exception:
            if owned_ref:
                with contextlib.suppress(Exception):
                    self.resolver.delete_keychain(owned_ref)
            raise LLMError("保存失败，请检查系统钥匙串权限和配置目录。") from None
        self.config.llm = llm
        return self.public()

    def reset(self) -> dict:
        if self.path:
            self.path.unlink(missing_ok=True)
        self.config.llm = self.original.model_copy(deep=True)
        return self.public()
