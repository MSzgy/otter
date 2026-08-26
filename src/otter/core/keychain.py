"""密钥解析器 —— 把 config 里的 `<scheme>:<ref>` 引用变成真实字符串。

支持的 scheme:
    - keychain:<service>[/<account>]  macOS Keychain(通过 `keyring` 库,便于将来跨平台)
    - env:<VAR_NAME>                  环境变量
    - file:/path/to/secret            读文件内容(去尾部空白)

配置中永远只放引用,不放明文,便于 config.toml 进版本控制。

设计说明:
    `DefaultSecretResolver` 允许注入 keyring backend,便于测试(见 tests/unit/test_keychain.py)。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Protocol


class SecretError(Exception):
    """密钥解析失败:引用格式错、条目不存在、文件读不到等。"""


class SecretResolver(Protocol):
    """插件签名:凡是需要密钥的地方(Collector / LLM)接收 SecretResolver。"""

    def resolve(self, ref: str) -> str: ...


class DefaultSecretResolver:
    """默认实现,按前缀路由到 keychain / env / file。"""

    def __init__(self, keyring_backend: Any = None) -> None:
        # 允许测试注入 fake;生产环境用真实 keyring 模块
        if keyring_backend is None:
            import keyring  # 延迟导入,便于测试环境不装 keyring 也能 import 本模块

            self._keyring: Any = keyring
        else:
            self._keyring = keyring_backend

    def resolve(self, ref: str) -> str:
        try:
            scheme, rest = ref.split(":", 1)
        except ValueError as e:
            raise SecretError(
                f"密钥引用格式错误(应为 <scheme>:<ref>):{ref!r}"
            ) from e

        if scheme == "keychain":
            return self._resolve_keychain(rest)
        if scheme == "env":
            return self._resolve_env(rest)
        if scheme == "file":
            return self._resolve_file(rest)
        raise SecretError(f"未知的密钥 scheme:{scheme!r},支持:keychain / env / file")

    # ── keychain ──
    def _resolve_keychain(self, ref: str) -> str:
        service, account = self._parse_keychain_ref(ref)
        value = self._keyring.get_password(service, account)
        if value is None:
            raise SecretError(
                f"Keychain 未找到条目 service={service!r} account={account!r}。\n"
                f"用 `otter secret set keychain:{ref}` 录入。"
            )
        return value

    def set_keychain(self, ref: str, value: str) -> None:
        """辅助:供 `otter secret set` 命令写入 Keychain。"""
        service, account = self._parse_keychain_ref(ref)
        self._keyring.set_password(service, account, value)

    def delete_keychain(self, ref: str) -> None:
        service, account = self._parse_keychain_ref(ref)
        self._keyring.delete_password(service, account)

    @staticmethod
    def _parse_keychain_ref(ref: str) -> tuple[str, str]:
        """解析 `service[/account]` → (service, account)。缺省 account = 'default'。"""
        if not ref:
            raise SecretError("keychain 引用不能为空(例:keychain:otter/claude)")
        service, _, account = ref.partition("/")
        return service, (account or "default")

    # ── env ──
    @staticmethod
    def _resolve_env(name: str) -> str:
        if not name:
            raise SecretError("env 引用不能为空(例:env:GITHUB_TOKEN)")
        value = os.environ.get(name)
        if value is None:
            raise SecretError(f"环境变量 {name!r} 未设置")
        return value

    # ── file ──
    @staticmethod
    def _resolve_file(path_str: str) -> str:
        if not path_str:
            raise SecretError("file 引用不能为空(例:file:~/.secrets/gh)")
        path = Path(path_str).expanduser()
        if not path.exists():
            raise SecretError(f"密钥文件不存在:{path}")
        return path.read_text(encoding="utf-8").rstrip("\n\r")
