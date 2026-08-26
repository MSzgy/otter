"""Typer CLI —— 命令入口。

设计要点:
    - Typer + Rich 是唯一的顶层依赖(langgraph / store / orchestrator 都在命令
      函数内 lazy import),这样 `otter --version` / `otter --help` 启动瞬间返回。
    - 错误呈现:业务层已经把 ConfigError / OrchestratorError / SecretError 抛成
      人类可读的消息,CLI 只负责 catch → 红字打印 → 非零退出;不吐 traceback。
    - Config 加载走统一 `_load_config()`,允许 `--config` 覆盖默认路径。
    - 时区:所有窗口计算走 config 里的 timezone,CLI 只接收本地日期字符串。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import typer
from rich.console import Console
from rich.table import Table

from otter import __version__

app = typer.Typer(
    name="otter",
    help="🦦 Otter — 私人 Mac 工作助理。",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()
err_console = Console(stderr=True)

# 子命令组:secret 有 set / get / delete
secret_app = typer.Typer(help="Keychain / env / file 密钥管理。")
app.add_typer(secret_app, name="secret")

# 子命令组:github 有 auth(通过 gh CLI 拿 token)
github_app = typer.Typer(help="GitHub 相关工具。")
app.add_typer(github_app, name="github")

outlook_app = typer.Typer(help="Outlook / Microsoft Graph 相关工具。")
app.add_typer(outlook_app, name="outlook")


# ────────────────────── 工具 ──────────────────────


def _version_callback(value: bool) -> None:
    if value:
        console.print(f"otter [bold cyan]{__version__}[/] 🦦")
        raise typer.Exit()


def _load_config(config_path: str | None):
    """统一加载 Config,遇到异常打印后 exit(2)。"""
    from otter.core.config import ConfigError, load

    try:
        return load(config_path)
    except ConfigError as e:
        err_console.print(f"[bold red]配置错误[/]:{e}")
        raise typer.Exit(code=2) from None


def _open_store(cfg):
    """打开并迁移 Store。"""
    from otter.core.store import Store

    store = Store(cfg.data_path() / "otter.db")
    store.migrate()
    return store


def _default_report_date(cfg) -> str:
    """默认报告日期 = 昨天(按 config 时区)。早晨跑 cron 时正好覆盖前一日工作。"""
    tz = ZoneInfo(cfg.core.timezone)
    yesterday = datetime.now(tz).date() - timedelta(days=1)
    return yesterday.isoformat()


def _default_collect_date(cfg) -> str:
    """默认采集日期 = 今天。"""
    tz = ZoneInfo(cfg.core.timezone)
    return datetime.now(tz).date().isoformat()


def _window_from_date(cfg, date: str) -> tuple[datetime, datetime]:
    """本地 YYYY-MM-DD → [00:00, 次日 00:00) 的 UTC 窗口。"""
    tz = ZoneInfo(cfg.core.timezone)
    local_midnight = datetime.fromisoformat(date).replace(tzinfo=tz)
    since = local_midnight.astimezone(UTC)
    until = (local_midnight + timedelta(days=1)).astimezone(UTC)
    return since, until


def _make_orchestrator(cfg, store):
    """组装 Orchestrator。lazy import,避免非编排命令(show/doctor/secret)拖 langgraph。"""
    from otter.core.keychain import DefaultSecretResolver
    from otter.core.orchestrator import Orchestrator
    from otter.summarizer.renderer import Renderer

    return Orchestrator(
        config=cfg,
        store=store,
        renderer=Renderer(config=cfg.prompts, project_root=cfg.report_path().parent),
        resolver=DefaultSecretResolver(),
    )


def _run_notifier_pipeline(cfg, report) -> None:
    """按 config.notifiers.pipeline 顺序调 Notifier。单个失败只 warn 不中断。"""
    from otter.core.keychain import DefaultSecretResolver
    from otter.core.notifier import NotifierError
    from otter.core.registry import NOTIFIERS

    pipeline = cfg.notifiers.pipeline
    if not pipeline:
        return

    resolver = DefaultSecretResolver()
    for name in pipeline:
        try:
            cls = NOTIFIERS.get(name)
            notifier = cls(config=cfg.notifiers.config_for(name), resolver=resolver)
            notifier.notify(report)
        except NotifierError as e:
            err_console.print(f"[yellow]![/] notifier {name} 失败:{e}")
        except Exception as e:
            err_console.print(f"[yellow]![/] notifier {name} 异常:{e!r}")


# ────────────────────── 根 ──────────────────────


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="显示版本并退出。",
        is_eager=True,
        callback=_version_callback,
    ),
) -> None:
    pass


# ────────────────────── collect ──────────────────────


@app.command()
def collect(
    date: str | None = typer.Option(
        None, "--date", "-d",
        help="YYYY-MM-DD(本地日,默认今天)。与 --since/--until 二选一。",
    ),
    since: str | None = typer.Option(None, "--since", help="ISO 8601 起点(含),需带 tz。"),
    until: str | None = typer.Option(None, "--until", help="ISO 8601 终点(不含),需带 tz。"),
    config_path: str | None = typer.Option(None, "--config", help="配置文件路径。"),
) -> None:
    """采集当日或指定窗口的事件,幂等入库。"""
    cfg = _load_config(config_path)

    if (since is None) != (until is None):
        err_console.print("[bold red]--since 和 --until 必须同时提供[/]")
        raise typer.Exit(code=2)

    if since and until:
        s = datetime.fromisoformat(since)
        u = datetime.fromisoformat(until)
        if s.tzinfo is None or u.tzinfo is None:
            err_console.print(
                "[bold red]--since/--until 必须包含时区(如 2026-08-26T00:00:00+08:00)[/]"
            )
            raise typer.Exit(code=2)
        s = s.astimezone(UTC)
        u = u.astimezone(UTC)
    else:
        d = date or _default_collect_date(cfg)
        s, u = _window_from_date(cfg, d)

    with _open_store(cfg) as store:
        orch = _make_orchestrator(cfg, store)
        try:
            result = orch.collect_only(s, u)
        except Exception as e:
            err_console.print(f"[bold red]采集失败[/]:{e}")
            raise typer.Exit(code=1) from None

    console.print(f"[bold]窗口[/]:{s.isoformat()} → {u.isoformat()}")
    table = Table(title="采集结果", show_header=True, header_style="bold cyan")
    table.add_column("Source")
    table.add_column("Events", justify="right")
    table.add_column("Status")
    for src, events in sorted(result.events_by_source.items()):
        err = result.collector_errors.get(src)
        status = f"[red]{err}[/]" if err else "[green]ok[/]"
        table.add_row(src, str(len(events)), status)
    console.print(table)
    if result.upsert_stats:
        console.print(
            f"[bold]入库[/]:inserted={result.upsert_stats.get('inserted', 0)} "
            f"updated={result.upsert_stats.get('updated', 0)} "
            f"unchanged={result.upsert_stats.get('unchanged', 0)}"
        )
    if result.collector_errors:
        raise typer.Exit(code=3)


# ────────────────────── report ──────────────────────


@app.command()
def report(
    date: str | None = typer.Option(
        None, "--date", "-d", help="YYYY-MM-DD(本地日,默认昨天)。"
    ),
    llm: str | None = typer.Option(
        None, "--llm", help="覆盖 config 里的 LLM provider(如 mock)。"
    ),
    do_collect: bool = typer.Option(
        False, "--collect/--no-collect", help="生成前是否顺便采集当日事件。"
    ),
    config_path: str | None = typer.Option(None, "--config", help="配置文件路径。"),
) -> None:
    """基于 Store 里的事件生成简报,写入 SQLite reports 表 + reports/ 目录。"""
    cfg = _load_config(config_path)
    d = date or _default_report_date(cfg)
    s, u = _window_from_date(cfg, d)

    with _open_store(cfg) as store:
        orch = _make_orchestrator(cfg, store)
        try:
            if do_collect:
                daily = orch.run_daily(d, llm_provider=llm)
                rep = daily.report
            else:
                rep = orch.report_only(d, s, u, llm_provider=llm)
        except Exception as e:
            err_console.print(f"[bold red]生成失败[/]:{e}")
            raise typer.Exit(code=1) from None

        assert rep is not None
        # 从 SQLite 读回完整 Report 对象(rep 是 ReportResult DTO,内容在库里)
        db_report = store.get_report(rep.date)
        assert db_report is not None

    console.print(f"[bold green]✓[/] 简报已生成:{rep.report_path}")
    console.print(
        f"  事件数:{rep.event_count}  provider:{rep.llm_provider}  "
        f"model:{rep.llm_model}  "
        f"tokens={rep.prompt_tokens}/{rep.completion_tokens}"
    )

    # Notifier pipeline:失败一个不影响后续,只 warn
    _run_notifier_pipeline(cfg, db_report)


# ────────────────────── show ──────────────────────


@app.command()
def show(
    date: str | None = typer.Option(
        None, "--date", "-d", help="YYYY-MM-DD;不填看最近一条。"
    ),
    list_recent: int = typer.Option(
        0, "--list", "-l", help="列出最近 N 条(不打印正文)。"
    ),
    config_path: str | None = typer.Option(None, "--config", help="配置文件路径。"),
) -> None:
    """查看已生成的简报。"""
    cfg = _load_config(config_path)
    with _open_store(cfg) as store:
        if list_recent > 0:
            reports = store.list_reports(limit=list_recent)
            if not reports:
                console.print("[yellow](没有已生成的简报)[/]")
                return
            table = Table(
                title=f"最近 {len(reports)} 条",
                show_header=True,
                header_style="bold cyan",
            )
            table.add_column("Date")
            table.add_column("Events", justify="right")
            table.add_column("Provider")
            table.add_column("Model")
            table.add_column("Path")
            for r in reports:
                table.add_row(
                    r.date, str(r.event_count),
                    r.llm_provider or "-", r.llm_model or "-",
                    r.trace_path or "-",
                )
            console.print(table)
            return

        if date is None:
            recent = store.list_reports(limit=1)
            if not recent:
                console.print("[yellow](没有已生成的简报)[/]")
                raise typer.Exit(code=1)
            rep = recent[0]
        else:
            rep = store.get_report(date)
            if rep is None:
                err_console.print(f"[bold red]未找到 {date} 的简报[/]")
                raise typer.Exit(code=1)

    console.print(f"[bold]日期[/]:{rep.date}   [bold]事件[/]:{rep.event_count}")
    console.print(rep.content_md)


# ────────────────────── doctor ──────────────────────


@app.command()
def doctor(
    config_path: str | None = typer.Option(None, "--config", help="配置文件路径。"),
) -> None:
    """自检:config、目录、DB、插件、密钥。"""
    from otter.core.keychain import DefaultSecretResolver, SecretError
    from otter.core.registry import COLLECTORS, LLM_PROVIDERS

    ok = True

    def line(label: str, status: bool, detail: str = "") -> None:
        nonlocal ok
        mark = "[green]✓[/]" if status else "[red]✗[/]"
        console.print(f"  {mark} {label}" + (f"  [dim]{detail}[/]" if detail else ""))
        if not status:
            ok = False

    console.print("[bold]# 配置[/]")
    try:
        cfg = _load_config(config_path)
        line(
            "config.toml 加载", True,
            f"identity={cfg.identity.primary}, tz={cfg.core.timezone}",
        )
    except typer.Exit:
        raise
    except Exception as e:
        line("config.toml 加载", False, repr(e))
        raise typer.Exit(code=1) from None

    console.print("[bold]# 目录[/]")
    for label, p in (
        ("data_dir", cfg.data_path()),
        ("report_dir", cfg.report_path()),
        ("log_dir", cfg.log_path()),
    ):
        try:
            p.mkdir(parents=True, exist_ok=True)
            line(f"{label} = {p}", True)
        except Exception as e:
            line(f"{label} = {p}", False, repr(e))

    console.print("[bold]# 数据库[/]")
    try:
        with _open_store(cfg) as store:
            line(
                "SQLite migrate", True,
                f"schema_version={store.schema_version()}, events={store.event_count()}",
            )
    except Exception as e:
        line("SQLite migrate", False, repr(e))

    console.print("[bold]# Collectors[/]")
    enabled = {n for n, s in cfg.collectors.items() if s.get("enabled", True)}
    for n in COLLECTORS.names():
        state = "enabled" if n in enabled else "not configured"
        line(f"collector {n}", True, state)
    missing = enabled - set(COLLECTORS.names())
    for n in sorted(missing):
        line(f"collector {n}", False, "配置里启用但插件未注册")

    console.print("[bold]# LLM[/]")
    llm_names = LLM_PROVIDERS.names()
    line(
        "LLM registry",
        cfg.llm.provider in llm_names,
        f"providers={llm_names}, 选中={cfg.llm.provider}",
    )

    console.print("[bold]# 密钥[/]")
    resolver = DefaultSecretResolver()
    refs = _collect_secret_refs(cfg)
    if not refs:
        console.print("  [dim](配置里没有引用任何密钥)[/]")
    for label, ref in refs:
        try:
            resolver.resolve(ref)
            line(f"{label} → {ref}", True)
        except SecretError as e:
            line(f"{label} → {ref}", False, str(e).splitlines()[0])

    if not ok:
        raise typer.Exit(code=1)


def _collect_secret_refs(cfg) -> list[tuple[str, str]]:
    """扫 config 里所有 `*_ref` 字段,给 doctor 用。"""
    refs: list[tuple[str, str]] = []
    for name, sub in cfg.collectors.items():
        for k, v in sub.items():
            if k.endswith("_ref") and isinstance(v, str):
                refs.append((f"collectors.{name}.{k}", v))
    for name, sub in cfg.llm.providers.items():
        for k, v in sub.items():
            if k.endswith("_ref") and isinstance(v, str):
                refs.append((f"llm.{name}.{k}", v))
    return refs


# ────────────────────── secret ──────────────────────


@secret_app.command("set")
def secret_set(
    ref: str = typer.Argument(..., help="形如 `keychain:otter/claude`。"),
    value: str | None = typer.Option(
        None,
        "--value",
        help="要存的密钥值;不填则交互输入(推荐,避免留在 shell 历史)。",
    ),
) -> None:
    """写入 Keychain(仅支持 keychain: scheme,env / file 请自行 export / 写文件)。"""
    from otter.core.keychain import DefaultSecretResolver

    scheme, _, rest = ref.partition(":")
    if scheme != "keychain" or not rest:
        err_console.print(
            "[bold red]只支持写入 keychain: 引用[/]。env: 请 export;file: 请写文件。"
        )
        raise typer.Exit(code=2)

    if value is None:
        value = typer.prompt("密钥值", hide_input=True, confirmation_prompt=True)

    try:
        DefaultSecretResolver().set_keychain(rest, value)
    except Exception as e:
        err_console.print(f"[bold red]写入失败[/]:{e}")
        raise typer.Exit(code=1) from None
    console.print(f"[green]✓[/] 已写入 {ref}")


@secret_app.command("get")
def secret_get(
    ref: str = typer.Argument(..., help="任意 scheme:keychain / env / file。"),
    check_only: bool = typer.Option(
        False, "--check-only", help="只验证能取到,不打印值。",
    ),
) -> None:
    """读取(或验证)密钥。"""
    from otter.core.keychain import DefaultSecretResolver, SecretError

    try:
        value = DefaultSecretResolver().resolve(ref)
    except SecretError as e:
        err_console.print(f"[bold red]{e}[/]")
        raise typer.Exit(code=1) from None

    if check_only:
        console.print(f"[green]✓[/] {ref} 可解析({len(value)} 字符)")
    else:
        # stdout 打印,便于 `otter secret get ... | pbcopy`
        typer.echo(value)


@secret_app.command("delete")
def secret_delete(
    ref: str = typer.Argument(..., help="形如 `keychain:otter/claude`。"),
) -> None:
    """从 Keychain 删除条目。"""
    from otter.core.keychain import DefaultSecretResolver

    scheme, _, rest = ref.partition(":")
    if scheme != "keychain" or not rest:
        err_console.print("[bold red]只支持删除 keychain: 引用[/]")
        raise typer.Exit(code=2)
    try:
        DefaultSecretResolver().delete_keychain(rest)
    except Exception as e:
        err_console.print(f"[bold red]删除失败[/]:{e}")
        raise typer.Exit(code=1) from None
    console.print(f"[green]✓[/] 已删除 {ref}")


# ────────────────────── github auth ──────────────────────


def _extract_hostname(base_url: str) -> str | None:
    """从 `https://github.tools.sap/api/v3` 提取 `github.tools.sap`。"""
    from urllib.parse import urlparse

    if not base_url:
        return None
    return urlparse(base_url).hostname


def _gh_token(hostname: str) -> str | None:
    """跑 `gh auth token --hostname <host>`;失败返回 None。"""
    import subprocess

    try:
        result = subprocess.run(
            ["gh", "auth", "token", "--hostname", hostname],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    token = result.stdout.strip()
    return token or None


@github_app.command("auth")
def github_auth(
    hostname: str | None = typer.Option(
        None, "--hostname", help="GitHub 主机名;默认从 [collectors.github].base_url 推导。",
    ),
    ref: str | None = typer.Option(
        None, "--ref",
        help="写入的 keychain 引用;默认读 [collectors.github].api_key_ref。",
    ),
    config_path: str | None = typer.Option(None, "--config", help="配置文件路径。"),
) -> None:
    """通过 `gh` CLI 拿 GitHub token,写入 Keychain。

    工作流:
        1. 先试 `gh auth token`,已登录直接拿到 token
        2. 没登录就跑 `gh auth login --web`,浏览器完成 device flow
        3. 拿到 token 后写入 config 里指定的 keychain 引用
    """
    import shutil
    import subprocess

    from otter.core.keychain import DefaultSecretResolver

    if shutil.which("gh") is None:
        err_console.print(
            "[bold red]找不到 gh 命令[/]。请先安装:\n"
            "  brew install gh\n"
            "或 https://cli.github.com/"
        )
        raise typer.Exit(code=1)

    cfg = _load_config(config_path)
    gh_cfg = cfg.collector_config("github")

    if hostname is None:
        hostname = _extract_hostname(gh_cfg.get("base_url", "")) or "github.com"

    if ref is None:
        ref = gh_cfg.get("api_key_ref")
        if not ref:
            err_console.print(
                "[bold red][collectors.github].api_key_ref 未配置,也没传 --ref[/]"
            )
            raise typer.Exit(code=2)

    if not ref.startswith("keychain:"):
        err_console.print(f"[bold red]目标 ref 必须是 keychain: 前缀,得到 {ref!r}[/]")
        raise typer.Exit(code=2)
    _, _, keychain_path = ref.partition(":")

    console.print(f"[dim]hostname={hostname}  ref={ref}[/]")

    token = _gh_token(hostname)
    if token is None:
        console.print(
            f"[cyan]gh 尚未登录 {hostname},启动浏览器授权…[/]\n"
            "[dim](按 gh 提示完成后,回到这里继续)[/]"
        )
        result = subprocess.run(
            [
                "gh", "auth", "login",
                "--hostname", hostname,
                "--web",
                "--scopes", "repo,read:user,read:org",
                "--git-protocol", "https",
            ],
            check=False,
        )
        if result.returncode != 0:
            err_console.print(
                f"[bold red]gh auth login 失败(exit={result.returncode})[/]"
            )
            raise typer.Exit(code=1)
        token = _gh_token(hostname)

    if not token:
        err_console.print(
            f"[bold red]gh 登录后仍取不到 token(hostname={hostname})[/]"
        )
        raise typer.Exit(code=1)

    try:
        DefaultSecretResolver().set_keychain(keychain_path, token)
    except Exception as e:
        err_console.print(f"[bold red]写入 Keychain 失败[/]:{e}")
        raise typer.Exit(code=1) from None

    console.print(f"[green]✓[/] token 已写入 {ref}({len(token)} 字符)")


# ────────────────────── outlook auth ──────────────────────


def _msal_device_flow(
    client_id: str, tenant_id: str, scopes: list[str],
    *, on_prompt=None,
) -> dict:
    """跑一次 MSAL device flow,返回 result dict(含 access_token / refresh_token)。

    抽成独立函数是为了让 CLI 单测可以 monkeypatch 掉浏览器交互。
    """
    try:
        import msal
    except ImportError as e:
        raise RuntimeError(
            "缺少 msal 依赖,请 `uv sync` 后重试"
        ) from e

    app_ = msal.PublicClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}",
    )
    flow = app_.initiate_device_flow(scopes=scopes)
    if "user_code" not in flow:
        raise RuntimeError(f"initiate_device_flow 失败:{flow}")
    if on_prompt is not None:
        on_prompt(flow.get("message", ""))
    return app_.acquire_token_by_device_flow(flow)


@outlook_app.command("auth")
def outlook_auth(
    ref: str | None = typer.Option(
        None, "--ref",
        help="写入的 keychain 引用;默认读 [collectors.outlook].refresh_token_ref。",
    ),
    config_path: str | None = typer.Option(None, "--config", help="配置文件路径。"),
) -> None:
    """通过 MSAL device flow 授权 Microsoft Graph,把 refresh_token 写 Keychain。

    工作流:
        1. 读 config 里的 client_id / tenant_id / scopes
        2. 打印 device code + URL,你在浏览器完成登录
        3. 拿到 refresh_token 写入 Keychain(默认 keychain:otter/outlook)
    """
    from otter.core.keychain import DefaultSecretResolver

    cfg = _load_config(config_path)
    ol_cfg = cfg.collector_config("outlook")

    if ref is None:
        ref = ol_cfg.get("refresh_token_ref")
        if not ref:
            err_console.print(
                "[bold red][collectors.outlook].refresh_token_ref 未配置,也没传 --ref[/]"
            )
            raise typer.Exit(code=2)
    if not ref.startswith("keychain:"):
        err_console.print(f"[bold red]目标 ref 必须是 keychain: 前缀,得到 {ref!r}[/]")
        raise typer.Exit(code=2)
    _, _, keychain_path = ref.partition(":")

    client_id = str(
        ol_cfg.get("client_id") or "14d82eec-204b-4c2f-b7e8-296a70dab67e"
    )
    tenant_id = str(ol_cfg.get("tenant_id") or "common")
    scopes = ol_cfg.get("scopes") or ["Mail.Read", "Calendars.Read"]

    console.print(
        f"[dim]client_id={client_id}  tenant={tenant_id}  ref={ref}[/]"
    )

    try:
        result = _msal_device_flow(
            client_id, tenant_id, list(scopes),
            on_prompt=lambda msg: console.print(f"\n[cyan]{msg}[/]\n"),
        )
    except Exception as e:
        err_console.print(f"[bold red]device flow 启动失败[/]:{e}")
        raise typer.Exit(code=1) from None

    if not isinstance(result, dict) or "refresh_token" not in result:
        desc = result.get("error_description") if isinstance(result, dict) else result
        err_console.print(f"[bold red]授权未拿到 refresh_token[/]:{desc}")
        raise typer.Exit(code=1)

    refresh_token = str(result["refresh_token"])
    try:
        DefaultSecretResolver().set_keychain(keychain_path, refresh_token)
    except Exception as e:
        err_console.print(f"[bold red]写入 Keychain 失败[/]:{e}")
        raise typer.Exit(code=1) from None

    upn = (result.get("id_token_claims") or {}).get("preferred_username")
    if upn:
        console.print(f"[green]✓[/] {upn} 授权成功,refresh_token 已写入 {ref}")
    else:
        console.print(f"[green]✓[/] refresh_token 已写入 {ref}")


if __name__ == "__main__":
    app()
