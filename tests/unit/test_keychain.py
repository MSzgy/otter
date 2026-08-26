"""SecretResolver 单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from otter.core.keychain import DefaultSecretResolver, SecretError


class FakeKeyring:
    """内存 keyring 替身,便于测试。"""

    def __init__(self) -> None:
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, account: str) -> str | None:
        return self._store.get((service, account))

    def set_password(self, service: str, account: str, value: str) -> None:
        self._store[(service, account)] = value

    def delete_password(self, service: str, account: str) -> None:
        self._store.pop((service, account), None)


@pytest.fixture
def resolver() -> DefaultSecretResolver:
    return DefaultSecretResolver(keyring_backend=FakeKeyring())


# ─────────────── keychain scheme ───────────────


class TestKeychain:
    def test_resolve_with_account(self, resolver: DefaultSecretResolver) -> None:
        resolver.set_keychain("otter/claude", "sk-xxx")
        assert resolver.resolve("keychain:otter/claude") == "sk-xxx"

    def test_resolve_default_account(self, resolver: DefaultSecretResolver) -> None:
        # 无 account → 使用 "default"
        resolver.set_keychain("otter", "token-abc")
        assert resolver.resolve("keychain:otter") == "token-abc"

    def test_missing_entry_raises(self, resolver: DefaultSecretResolver) -> None:
        with pytest.raises(SecretError, match="Keychain 未找到"):
            resolver.resolve("keychain:missing/entry")

    def test_delete_keychain(self, resolver: DefaultSecretResolver) -> None:
        resolver.set_keychain("otter/claude", "sk-xxx")
        resolver.delete_keychain("otter/claude")
        with pytest.raises(SecretError):
            resolver.resolve("keychain:otter/claude")

    def test_empty_ref_raises(self, resolver: DefaultSecretResolver) -> None:
        with pytest.raises(SecretError, match="keychain 引用不能为空"):
            resolver.resolve("keychain:")


# ─────────────── env scheme ───────────────


class TestEnv:
    def test_resolve_env(
        self, resolver: DefaultSecretResolver, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("MY_TOKEN", "abc123")
        assert resolver.resolve("env:MY_TOKEN") == "abc123"

    def test_missing_env_raises(
        self, resolver: DefaultSecretResolver, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("NO_SUCH_VAR", raising=False)
        with pytest.raises(SecretError, match="未设置"):
            resolver.resolve("env:NO_SUCH_VAR")

    def test_empty_name_raises(self, resolver: DefaultSecretResolver) -> None:
        with pytest.raises(SecretError, match="env 引用不能为空"):
            resolver.resolve("env:")


# ─────────────── file scheme ───────────────


class TestFile:
    def test_resolve_file(
        self, resolver: DefaultSecretResolver, tmp_path: Path
    ) -> None:
        f = tmp_path / "secret.txt"
        f.write_text("my-secret\n", encoding="utf-8")
        assert resolver.resolve(f"file:{f}") == "my-secret"

    def test_strips_trailing_newlines(
        self, resolver: DefaultSecretResolver, tmp_path: Path
    ) -> None:
        f = tmp_path / "secret.txt"
        f.write_text("value\r\n\n", encoding="utf-8")
        assert resolver.resolve(f"file:{f}") == "value"

    def test_missing_file_raises(
        self, resolver: DefaultSecretResolver, tmp_path: Path
    ) -> None:
        with pytest.raises(SecretError, match="密钥文件不存在"):
            resolver.resolve(f"file:{tmp_path}/nope.txt")

    def test_empty_path_raises(self, resolver: DefaultSecretResolver) -> None:
        with pytest.raises(SecretError, match="file 引用不能为空"):
            resolver.resolve("file:")

    def test_expanduser(
        self,
        resolver: DefaultSecretResolver,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("HOME", str(tmp_path))
        f = tmp_path / ".secret"
        f.write_text("home-secret", encoding="utf-8")
        assert resolver.resolve("file:~/.secret") == "home-secret"


# ─────────────── 分派与错误处理 ───────────────


class TestDispatch:
    def test_unknown_scheme_raises(self, resolver: DefaultSecretResolver) -> None:
        with pytest.raises(SecretError, match="未知的密钥 scheme"):
            resolver.resolve("s3:bucket/key")

    def test_malformed_ref_raises(self, resolver: DefaultSecretResolver) -> None:
        with pytest.raises(SecretError, match="密钥引用格式错误"):
            resolver.resolve("no-colon-here")
