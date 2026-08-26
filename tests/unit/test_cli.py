"""CLI 测试 —— 覆盖 collect / report / show / doctor / secret 各命令。

策略:
    - Typer CliRunner + tmp_path 做隔离
    - 用 `OTTER_PROJECT_ROOT` 环境变量把项目根指向 tmp_path,写一个最小 config.toml
    - 注册两个 fake collector 进全局 COLLECTORS(测试后 unregister)
    - keyring 模块级 monkeypatch,避免真的动 macOS Keychain
"""

from __future__ import annotations

import textwrap
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, ClassVar

import pytest
from typer.testing import CliRunner

from otter.cli import app
from otter.core.event import Event, Ref
from otter.core.paths import _reset_cache_for_tests
from otter.core.registry import COLLECTORS

runner = CliRunner()


# ────────────────────── Fake collector / keyring ──────────────────────


class _FakeCollectorBase:
    name: ClassVar[str] = "fake"
    _events: ClassVar[list[Event]] = []

    def __init__(self, *, config: dict[str, Any], resolver: Any, identity: str) -> None:
        self.config = config
        self.resolver = resolver
        self.identity = identity

    def collect(self, since: datetime, until: datetime) -> Iterable[Event]:  # noqa: ARG002
        return iter(self._events)


class _FakeKeyringModule:
    """替代 `keyring` 模块的 get/set/delete_password 函数。"""

    def __init__(self) -> None:
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, account: str) -> str | None:
        return self.store.get((service, account))

    def set_password(self, service: str, account: str, value: str) -> None:
        self.store[(service, account)] = value

    def delete_password(self, service: str, account: str) -> None:
        self.store.pop((service, account), None)


# ────────────────────── Fixtures ──────────────────────


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """
    造一个临时项目根,包含 config.toml。CLI 命令跑起来后所有相对路径都基于这。
    """
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "config.toml").write_text(
        textwrap.dedent(
            """\
            schema_version = 1

            [core]
            timezone   = "Asia/Shanghai"
            data_dir   = "./data"
            report_dir = "./reports"
            log_dir    = "./logs"

            [identity]
            primary = "test@example.com"

            [llm]
            provider = "mock"

            [llm.mock]
            response = "# mock report\\n- a\\n- b"

            [collectors.alpha]
            enabled = true

            [collectors.beta]
            enabled = true
            api_key_ref = "keychain:otter/beta"
            """
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
    _reset_cache_for_tests()
    yield tmp_path
    _reset_cache_for_tests()


@pytest.fixture
def fake_collectors() -> Iterator[None]:
    """在 COLLECTORS 里注册 alpha / beta,测试后清掉。"""

    class Alpha(_FakeCollectorBase):
        name = "alpha"
        _events = [
            Event.build(
                source="alpha",
                source_id="c1",
                type="commit",
                timestamp=datetime(2026, 8, 26, 2, 0, tzinfo=UTC),
                title="fake commit",
                refs=[Ref(kind="repo", id="demo")],
            ),
        ]

    class Beta(_FakeCollectorBase):
        name = "beta"
        _events = []

    COLLECTORS.register("alpha", Alpha)
    COLLECTORS.register("beta", Beta)
    yield
    COLLECTORS.unregister("alpha")
    COLLECTORS.unregister("beta")


@pytest.fixture
def fake_keyring(monkeypatch: pytest.MonkeyPatch) -> _FakeKeyringModule:
    """把 CLI 里的 `import keyring` 换成 fake,避免动真实 macOS Keychain。"""
    import keyring as real_keyring

    fake = _FakeKeyringModule()
    monkeypatch.setattr(real_keyring, "get_password", fake.get_password)
    monkeypatch.setattr(real_keyring, "set_password", fake.set_password)
    monkeypatch.setattr(real_keyring, "delete_password", fake.delete_password)
    return fake


# ────────────────────── 顶层 ──────────────────────


class TestRoot:
    def test_version(self):
        r = runner.invoke(app, ["--version"])
        assert r.exit_code == 0
        assert "otter" in r.stdout

    def test_help(self):
        r = runner.invoke(app, ["--help"])
        assert r.exit_code == 0
        assert "collect" in r.stdout
        assert "report" in r.stdout


# ────────────────────── collect ──────────────────────


class TestCollect:
    def test_collect_default_date(self, project, fake_collectors):
        r = runner.invoke(app, ["collect", "--date", "2026-08-26"])
        assert r.exit_code == 0, r.stdout
        assert "alpha" in r.stdout
        assert "inserted=1" in r.stdout

    def test_collect_with_since_until(self, project, fake_collectors):
        r = runner.invoke(
            app,
            [
                "collect",
                "--since", "2026-08-25T16:00:00+00:00",
                "--until", "2026-08-26T16:00:00+00:00",
            ],
        )
        assert r.exit_code == 0, r.stdout
        assert "inserted=1" in r.stdout

    def test_collect_missing_tz_rejected(self, project, fake_collectors):
        r = runner.invoke(
            app,
            ["collect", "--since", "2026-08-26T00:00:00", "--until", "2026-08-27T00:00:00"],
        )
        assert r.exit_code == 2
        assert "时区" in r.stderr or "时区" in r.stdout

    def test_collect_partial_flags_rejected(self, project, fake_collectors):
        r = runner.invoke(app, ["collect", "--since", "2026-08-26T00:00:00+08:00"])
        assert r.exit_code == 2

    def test_collect_missing_config(self, tmp_path, monkeypatch, fake_collectors):
        monkeypatch.setenv("OTTER_PROJECT_ROOT", str(tmp_path))
        _reset_cache_for_tests()
        r = runner.invoke(app, ["collect", "--date", "2026-08-26"])
        assert r.exit_code == 2
        assert "配置" in r.stderr or "配置" in r.stdout


# ────────────────────── report ──────────────────────


class TestReport:
    def test_report_only(self, project, fake_collectors):
        # 先采集
        r = runner.invoke(app, ["collect", "--date", "2026-08-26"])
        assert r.exit_code == 0
        # 再基于 store 生成
        r = runner.invoke(app, ["report", "--date", "2026-08-26"])
        assert r.exit_code == 0, r.stdout
        assert "简报已生成" in r.stdout
        md = project / "reports" / "2026-08-26.md"
        assert md.exists()
        assert "mock" in md.read_text(encoding="utf-8")

    def test_report_with_collect(self, project, fake_collectors):
        r = runner.invoke(app, ["report", "--date", "2026-08-26", "--collect"])
        assert r.exit_code == 0, r.stdout
        assert (project / "reports" / "2026-08-26.md").exists()

    def test_report_llm_override(self, project, fake_collectors):
        r = runner.invoke(
            app,
            ["report", "--date", "2026-08-26", "--collect", "--llm", "mock"],
        )
        assert r.exit_code == 0, r.stdout


# ────────────────────── notifier pipeline ──────────────────────


class TestNotifierPipeline:
    def _append_notifiers(self, project: Path, body: str) -> None:
        cfg = project / "config" / "config.toml"
        cfg.write_text(cfg.read_text(encoding="utf-8") + body, encoding="utf-8")

    def test_file_notifier_writes_extra_copy(self, project, fake_collectors, tmp_path):
        extra_dir = tmp_path / "vault"
        self._append_notifiers(
            project,
            textwrap.dedent(
                f"""

                [notifiers]
                pipeline = ["file"]

                [notifiers.file]
                dir = "{extra_dir}"
                """
            ),
        )
        r = runner.invoke(app, ["report", "--date", "2026-08-26", "--collect"])
        assert r.exit_code == 0, r.stdout
        # 默认 report_dir 一份 + notifier 副本一份
        assert (project / "reports" / "2026-08-26.md").exists()
        assert (extra_dir / "2026-08-26.md").exists()

    def test_stdout_notifier_prints_header(self, project, fake_collectors):
        self._append_notifiers(
            project,
            textwrap.dedent(
                """

                [notifiers]
                pipeline = ["stdout"]

                [notifiers.stdout]
                header = true
                """
            ),
        )
        r = runner.invoke(app, ["report", "--date", "2026-08-26", "--collect"])
        assert r.exit_code == 0, r.stdout
        assert "# 日报 · 2026-08-26" in r.stdout

    def test_notifier_failure_does_not_abort(
        self, project, fake_collectors, tmp_path
    ):
        # file notifier 配了不合法的 filename_template,失败;后面的 stdout 仍然继续
        extra_dir = tmp_path / "vault"
        self._append_notifiers(
            project,
            textwrap.dedent(
                f"""

                [notifiers]
                pipeline = ["file", "stdout"]

                [notifiers.file]
                dir = "{extra_dir}"
                filename_template = "{{invalid}}.md"

                [notifiers.stdout]
                header = false
                """
            ),
        )
        r = runner.invoke(app, ["report", "--date", "2026-08-26", "--collect"])
        # report 主体成功,notifier 单个失败只 warn
        assert r.exit_code == 0, r.stdout
        assert "notifier file 失败" in r.stderr or "notifier file 失败" in r.stdout
        # stdout notifier 仍打印了内容
        assert "mock" in r.stdout


# ────────────────────── show ──────────────────────


class TestShow:
    def test_show_specific_date(self, project, fake_collectors):
        runner.invoke(app, ["report", "--date", "2026-08-26", "--collect"])
        r = runner.invoke(app, ["show", "--date", "2026-08-26"])
        assert r.exit_code == 0, r.stdout
        assert "mock" in r.stdout
        assert "2026-08-26" in r.stdout

    def test_show_latest(self, project, fake_collectors):
        runner.invoke(app, ["report", "--date", "2026-08-26", "--collect"])
        r = runner.invoke(app, ["show"])
        assert r.exit_code == 0
        assert "mock" in r.stdout

    def test_show_missing_date_returns_error(self, project, fake_collectors):
        r = runner.invoke(app, ["show", "--date", "1999-01-01"])
        assert r.exit_code == 1
        assert "未找到" in r.stderr or "未找到" in r.stdout

    def test_show_no_reports(self, project, fake_collectors):
        r = runner.invoke(app, ["show"])
        assert r.exit_code == 1

    def test_show_list(self, project, fake_collectors):
        runner.invoke(app, ["report", "--date", "2026-08-26", "--collect"])
        r = runner.invoke(app, ["show", "--list", "5"])
        assert r.exit_code == 0
        assert "2026-08-26" in r.stdout


# ────────────────────── doctor ──────────────────────


class TestDoctor:
    def test_doctor_reports_secret_missing(self, project, fake_collectors, fake_keyring):
        # config 引用了 keychain:otter/beta,但没写入,doctor 应报错
        r = runner.invoke(app, ["doctor"])
        assert r.exit_code == 1
        assert "config.toml" in r.stdout
        assert "collectors.beta.api_key_ref" in r.stdout

    def test_doctor_all_green_after_setting_secret(
        self, project, fake_collectors, fake_keyring
    ):
        fake_keyring.set_password("otter", "beta", "token-xyz")
        r = runner.invoke(app, ["doctor"])
        assert r.exit_code == 0, r.stdout


# ────────────────────── secret ──────────────────────


class TestSecret:
    def test_set_and_get(self, project, fake_keyring):
        r = runner.invoke(
            app, ["secret", "set", "keychain:otter/claude", "--value", "sk-abc"]
        )
        assert r.exit_code == 0, r.stdout
        assert fake_keyring.get_password("otter", "claude") == "sk-abc"

        r = runner.invoke(app, ["secret", "get", "keychain:otter/claude"])
        assert r.exit_code == 0
        assert "sk-abc" in r.stdout

    def test_get_check_only_hides_value(self, project, fake_keyring):
        fake_keyring.set_password("otter", "claude", "top-secret-value")
        r = runner.invoke(app, ["secret", "get", "keychain:otter/claude", "--check-only"])
        assert r.exit_code == 0
        assert "top-secret-value" not in r.stdout
        assert "可解析" in r.stdout

    def test_get_missing_returns_error(self, project, fake_keyring):
        r = runner.invoke(app, ["secret", "get", "keychain:otter/nope"])
        assert r.exit_code == 1

    def test_get_env_ref(self, project, monkeypatch):
        monkeypatch.setenv("OTTER_TEST_SECRET", "env-value")
        r = runner.invoke(app, ["secret", "get", "env:OTTER_TEST_SECRET"])
        assert r.exit_code == 0
        assert "env-value" in r.stdout

    def test_delete(self, project, fake_keyring):
        fake_keyring.set_password("otter", "claude", "sk-abc")
        r = runner.invoke(app, ["secret", "delete", "keychain:otter/claude"])
        assert r.exit_code == 0
        assert fake_keyring.get_password("otter", "claude") is None

    def test_set_rejects_non_keychain(self, project):
        r = runner.invoke(app, ["secret", "set", "env:FOO", "--value", "x"])
        assert r.exit_code == 2


# ────────────────────── github auth ──────────────────────


class _FakeGhRuns:
    """记录并伪造 subprocess.run 对 gh 的调用。"""

    def __init__(self, *, token_after_login: str | None = "gh-token-abc"):
        self.calls: list[list[str]] = []
        self._logged_in = False
        self._token_after_login = token_after_login
        self.login_returncode = 0

    def __call__(self, args, **kwargs):
        self.calls.append(list(args))
        # 只处理 gh 的两条命令
        if args[:3] == ["gh", "auth", "token"]:
            if self._logged_in and self._token_after_login is not None:
                return _CompletedProcess(0, self._token_after_login + "\n", "")
            return _CompletedProcess(1, "", "not logged in")
        if args[:3] == ["gh", "auth", "login"]:
            if self.login_returncode == 0:
                self._logged_in = True
            return _CompletedProcess(self.login_returncode, "", "")
        return _CompletedProcess(0, "", "")


class _CompletedProcess:
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class TestGithubAuth:
    def test_uses_existing_gh_token(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch
    ):
        fake = _FakeGhRuns()
        fake._logged_in = True  # 假装已登录
        monkeypatch.setattr("shutil.which", lambda _: "/opt/homebrew/bin/gh")
        monkeypatch.setattr("subprocess.run", fake)

        r = runner.invoke(
            app,
            ["github", "auth", "--ref", "keychain:otter/github", "--hostname", "github.tools.sap"],
        )
        assert r.exit_code == 0, r.stdout + r.stderr
        # 只调了 gh auth token,没调 login
        assert any(c[:3] == ["gh", "auth", "token"] for c in fake.calls)
        assert not any(c[:3] == ["gh", "auth", "login"] for c in fake.calls)
        # token 落进了 fake keychain
        assert fake_keyring.get_password("otter", "github") == "gh-token-abc"
        assert "token 已写入" in r.stdout

    def test_runs_login_when_not_authenticated(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch
    ):
        fake = _FakeGhRuns()  # 初始未登录,login 后可拿 token
        monkeypatch.setattr("shutil.which", lambda _: "/opt/homebrew/bin/gh")
        monkeypatch.setattr("subprocess.run", fake)

        r = runner.invoke(
            app,
            ["github", "auth", "--ref", "keychain:otter/github"],
        )
        assert r.exit_code == 0, r.stdout + r.stderr
        assert any(c[:3] == ["gh", "auth", "login"] for c in fake.calls)
        # 至少 2 次 token 调用:登录前失败一次,登录后成功一次
        token_calls = [c for c in fake.calls if c[:3] == ["gh", "auth", "token"]]
        assert len(token_calls) >= 2
        assert fake_keyring.get_password("otter", "github") == "gh-token-abc"

    def test_gh_missing_errors(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr("shutil.which", lambda _: None)
        r = runner.invoke(app, ["github", "auth"])
        assert r.exit_code == 1
        assert "gh" in r.stderr or "gh" in r.stdout

    def test_login_failure_exits_nonzero(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch
    ):
        fake = _FakeGhRuns()
        fake.login_returncode = 1
        monkeypatch.setattr("shutil.which", lambda _: "/opt/homebrew/bin/gh")
        monkeypatch.setattr("subprocess.run", fake)

        r = runner.invoke(app, ["github", "auth", "--ref", "keychain:otter/github"])
        assert r.exit_code == 1
        assert fake_keyring.get_password("otter", "github") is None

    def test_ref_must_be_keychain(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr("shutil.which", lambda _: "/opt/homebrew/bin/gh")
        # subprocess 不该被调
        monkeypatch.setattr("subprocess.run", _FakeGhRuns())

        r = runner.invoke(
            app,
            ["github", "auth", "--ref", "env:GITHUB_TOKEN"],
        )
        assert r.exit_code == 2
        assert "keychain:" in r.stdout or "keychain:" in r.stderr

    def test_hostname_derived_from_base_url(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch
    ):
        # 在 config 里加 [collectors.github] 段(project 默认没有它)
        cfg = project / "config" / "config.toml"
        cfg.write_text(
            cfg.read_text(encoding="utf-8")
            + '\n[collectors.github]\nenabled = false\n'
            'base_url = "https://github.tools.sap/api/v3"\n'
            'api_key_ref = "keychain:otter/github"\n',
            encoding="utf-8",
        )

        fake = _FakeGhRuns()
        fake._logged_in = True
        monkeypatch.setattr("shutil.which", lambda _: "/opt/homebrew/bin/gh")
        monkeypatch.setattr("subprocess.run", fake)

        # 不传 --ref / --hostname,看是否从 config 推导
        r = runner.invoke(app, ["github", "auth"])
        assert r.exit_code == 0, r.stdout + r.stderr
        # 断言传给 gh 的 hostname 是从 base_url 推出的
        token_calls = [c for c in fake.calls if c[:3] == ["gh", "auth", "token"]]
        assert token_calls, "should have called gh auth token"
        assert "github.tools.sap" in token_calls[0]
        # 落到默认 ref
        assert fake_keyring.get_password("otter", "github") == "gh-token-abc"


# ────────────────────── outlook auth ──────────────────────


class TestOutlookAuth:
    def _write_outlook_cfg(self, project):
        cfg = project / "config" / "config.toml"
        cfg.write_text(
            cfg.read_text(encoding="utf-8")
            + "\n[collectors.outlook]\nenabled = false\n"
            'client_id = "fake-client"\n'
            'tenant_id = "common"\n'
            'refresh_token_ref = "keychain:otter/outlook"\n'
            'scopes = ["Mail.Read", "Calendars.Read"]\n',
            encoding="utf-8",
        )

    def test_happy_path_writes_refresh_token(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch,
    ):
        self._write_outlook_cfg(project)

        def fake_flow(client_id, tenant_id, scopes, *, on_prompt=None):
            if on_prompt:
                on_prompt("Go to https://microsoft.com/devicelogin and enter code ABC-123")
            return {
                "access_token": "at",
                "refresh_token": "rt-xyz",
                "id_token_claims": {"preferred_username": "user@sap.com"},
            }

        monkeypatch.setattr("otter.cli._msal_device_flow", fake_flow)

        r = runner.invoke(app, ["outlook", "auth"])
        assert r.exit_code == 0, r.stdout + r.stderr
        assert fake_keyring.get_password("otter", "outlook") == "rt-xyz"
        assert "user@sap.com" in r.stdout

    def test_missing_refresh_token_in_result(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch,
    ):
        self._write_outlook_cfg(project)
        monkeypatch.setattr(
            "otter.cli._msal_device_flow",
            lambda *a, **kw: {"error_description": "user cancelled"},
        )
        r = runner.invoke(app, ["outlook", "auth"])
        assert r.exit_code == 1
        assert fake_keyring.get_password("otter", "outlook") is None

    def test_ref_must_be_keychain(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch,
    ):
        self._write_outlook_cfg(project)
        # 用 --ref 覆盖成 env:...,应被拒
        r = runner.invoke(
            app, ["outlook", "auth", "--ref", "env:OUTLOOK_TOKEN"],
        )
        assert r.exit_code == 2
        assert "keychain:" in r.stdout or "keychain:" in r.stderr

    def test_flow_raises_reports_error(
        self, project, fake_keyring, monkeypatch: pytest.MonkeyPatch,
    ):
        self._write_outlook_cfg(project)

        def boom(*a, **kw):
            raise RuntimeError("initiate_device_flow 失败:no user_code")

        monkeypatch.setattr("otter.cli._msal_device_flow", boom)
        r = runner.invoke(app, ["outlook", "auth"])
        assert r.exit_code == 1
        assert "device flow" in r.stdout or "device flow" in r.stderr
