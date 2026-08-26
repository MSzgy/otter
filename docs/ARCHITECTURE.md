# Otter · 架构设计

> 版本:v0.1 · 起草日期:2026-08-26
> 关联文档:`../REQUIREMENTS.md`
> 一号约束:**可扩展**。所有"未来会接入的系统"(新数据源、新 LLM、新报告去处)都必须通过明确的插件契约接入,不改核心代码。

---

## 1. 设计原则

1. **契约先行,实现在后** — 核心只依赖 Protocol,不依赖具体实现。
2. **插件优于分支** — 新数据源写成插件,不在 `if source == "github"` 里加 else。
3. **配置驱动一切** — 启用哪些采集器、走哪个 LLM、几点触发,全部走 `config.toml`,代码不硬编码。
4. **本地优先,凭证隔离** — 数据 SQLite,密钥走 macOS Keychain,只有 LLM 调用会出网(且可关)。
5. **失败隔离** — 一个 Collector 挂掉不影响其他;LLM 失败保留原始 events,下次能重试。
6. **可观测** — 每次运行都有结构化日志和可查询的运行记录。
7. **可迁移** — 换台 Mac,`brew install` + `otter init` 应该在 10 分钟内跑起来。

---

## 2. 高层架构

```
                       ┌──────────────────────────┐
                       │       launchd / cron     │
                       └────────────┬─────────────┘
                                    ▼
                       ┌──────────────────────────┐
   ┌───────────────────│      Orchestrator        │───────────────────┐
   │                   └────────────┬─────────────┘                   │
   │                                │                                 │
   ▼                                ▼                                 ▼
┌─────────┐             ┌───────────────────────┐             ┌───────────┐
│ Config  │             │  Collector Registry   │             │ Keychain  │
│ Loader  │             │  (entry_points)       │             │  Access   │
└─────────┘             └──────────┬────────────┘             └───────────┘
                                   │ discovers
             ┌─────────────────────┼─────────────────────────┐
             ▼                     ▼                         ▼
       ┌──────────┐          ┌──────────┐              ┌──────────┐
       │  Git     │          │ GitHub   │   ......     │ <Your    │
       │Collector │          │Collector │              │ Plugin>  │
       └────┬─────┘          └────┬─────┘              └────┬─────┘
            │  Iterable[Event]    │                         │
            └────────┬────────────┴─────────────────────────┘
                     ▼
              ┌─────────────┐
              │  Event      │  ← 归一化 + 去重
              │  Store      │     SQLite
              └──────┬──────┘
                     │ Query(window)
                     ▼
              ┌─────────────┐         ┌──────────────┐
              │  Enricher   │──────▶  │ LLM Provider │  ← Claude/OpenAI/Ollama/Mock
              │  Pipeline   │ prompt  │  (Adapter)   │
              └──────┬──────┘         └───────┬──────┘
                     │                        │
                     └────────┬───────────────┘
                              ▼
                       ┌──────────────┐
                       │  Reporter    │  → Markdown 文件
                       └──────┬───────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │ Notifier Chain                │
              │  · File  · macOS Notification │
              │  · Menu Bar (阶段 2)          │
              └───────────────────────────────┘
```

**核心思路**:上下两端(Collectors 和 Notifiers)完全插件化,中间的 `Event Store + Enricher + LLM` 是稳定内核。

---

## 3. 目录结构

**运行时目录**(项目内,便于整包搬迁到别的 Mac):

```
AI_Work_assistant/                 # 项目根 = 数据根
├── config/
│   ├── config.toml                # ← 主配置(gitignore)
│   ├── config.example.toml        # 模板,进版本控制
│   └── prompts/                   # 用户覆盖的 Jinja 提示词(可选)
├── data/                          # SQLite (gitignore)
│   └── otter.db
├── reports/                       # 生成的 Markdown 报告 (gitignore)
│   └── 2026-08-26.md
├── logs/                          # 运行日志 (gitignore)
│   └── otter.log
└── ...(源码见下)
```

**`.gitignore` 建议**:`data/`、`reports/`、`logs/`、`config/config.toml`、`config/prompts/*` —— 只有 `config.example.toml` 和源码进版本控制。

**源码目录**:

```
AI_Work_assistant/
├── pyproject.toml                 # 项目元数据 + 依赖 + entry_points
├── uv.lock                        # 依赖锁,进版本控制
├── README.md
├── REQUIREMENTS.md
├── docs/
│   ├── ARCHITECTURE.md            # ← 本文
│   ├── PLUGIN_DEVELOPMENT.md      # 后续补:如何写一个 Collector 插件
│   └── CONFIG_REFERENCE.md        # 后续补:config.toml 完整字段说明
├── src/
│   └── otter/
│       ├── __init__.py            # __version__
│       ├── cli.py                 # Typer entry
│       ├── core/
│       │   ├── event.py           # Event, Ref, EventType (pydantic)
│       │   ├── config.py          # Config schema + 加载/校验
│       │   ├── registry.py        # 插件发现(entry_points)
│       │   ├── store.py           # SQLite 持久化 + 去重
│       │   ├── keychain.py        # macOS Keychain 封装
│       │   ├── scheduler.py       # launchd plist 生成/安装
│       │   ├── orchestrator.py    # 主流程:collect → summarize → notify
│       │   ├── paths.py           # 项目根解析 + 相对路径展开
│       │   ├── logging.py         # 结构化日志
│       │   └── errors.py          # 领域异常
│       ├── collectors/
│       │   ├── base.py            # Collector Protocol + BaseCollector
│       │   ├── git_local.py       # 内置:本地 Git
│       │   ├── github.py          # 内置:GitHub REST/GraphQL
│       │   ├── jira.py            # 内置:Jira REST
│       │   └── browser_chrome.py  # 内置:Chrome 历史
│       ├── llm/
│       │   ├── base.py            # LLMProvider Protocol
│       │   ├── claude.py
│       │   ├── openai_compat.py   # 兼容 OpenAI 协议(DeepSeek/Azure 等)
│       │   ├── ollama.py
│       │   └── mock.py
│       ├── enrichers/
│       │   ├── base.py            # Enricher Protocol
│       │   ├── dedupe.py
│       │   ├── clustering.py      # 把同一 PR 的多个事件聚成一条
│       │   └── tagging.py         # 基于关键词打标签(可扩展)
│       ├── summarizer/
│       │   ├── pipeline.py        # 组合 enrichers + LLM
│       │   ├── prompts/           # jinja2 模板(内置默认)
│       │   │   ├── daily.md.j2
│       │   │   └── weekly.md.j2
│       │   └── renderer.py        # Markdown 渲染
│       ├── notifiers/
│       │   ├── base.py            # Notifier Protocol
│       │   ├── file.py
│       │   ├── stdout.py
│       │   └── macos.py           # 系统通知中心
│       └── migrations/            # SQL 迁移脚本
│           ├── 001_initial.sql
│           └── ...
├── plugins/                       # 第三方插件目录(pip 也能装,这里可放本地开发的)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                  # 假事件数据、mock LLM 响应
├── scripts/
│   ├── install.sh                 # curl … | bash 入口
│   ├── uninstall.sh
│   └── com.otter.daily.plist.tmpl # launchd 模板
└── examples/
    └── plugin_template/           # 拷贝即可开发的插件骨架
```

---

## 4. 核心抽象(扩展点)

系统有 **4 个明确的扩展点**,每个都是 Protocol,通过 `entry_points` 注册:

| 扩展点 | 契约 | Entry Point Group | 何时新增 |
|--------|------|-------------------|---------|
| Collector | 采集事件 | `otter.collectors` | 接入新数据源(Slack、Linear、Notion…) |
| LLM Provider | 生成总结 | `otter.llm` | 接入新模型后端 |
| Enricher | 事件后处理 | `otter.enrichers` | 加标签、聚类、脱敏等 |
| Notifier | 分发报告 | `otter.notifiers` | 发到邮箱、Slack、Discord… |

### 4.1 Collector Protocol

```python
# src/otter/collectors/base.py
from typing import Protocol, Iterable
from datetime import datetime
from otter.core.event import Event

class Collector(Protocol):
    name: str                      # 唯一 slug,如 "github"
    version: str

    def configure(self, cfg: dict, secrets: SecretResolver) -> None:
        """由 config.toml 里 [collectors.<name>] 段构造。"""

    def collect(
        self,
        since: datetime,
        until: datetime,
        cursor: str | None,
    ) -> "CollectResult":
        """
        增量拉取 [since, until) 内的事件。
        cursor 是上次运行留下的分页游标(source 自定义语义)。
        """

    def health_check(self) -> "HealthStatus":
        """自检:凭证有效、网络可达。用于 `otter doctor`。"""

@dataclass
class CollectResult:
    events: list[Event]
    next_cursor: str | None
    warnings: list[str] = field(default_factory=list)
```

**要点**:
- Collector 只负责"从源头拿数据 + 归一成 Event",不管存储、不管去重、不管 LLM。
- 增量与幂等:cursor + since/until 保证多次跑同一天不重复。
- 失败上抛结构化异常;编排器负责隔离和重试。

### 4.2 LLM Provider Protocol

```python
class LLMProvider(Protocol):
    name: str

    def configure(self, cfg: dict, secrets: SecretResolver) -> None: ...

    def complete(self, messages: list[Message], **opts) -> "Completion":
        """
        统一走 messages 数组接口(system + user)。
        opts 支持 max_tokens、temperature 等;不识别的字段应静默忽略。
        """

    def health_check(self) -> HealthStatus: ...

@dataclass
class Completion:
    text: str
    prompt_tokens: int | None
    completion_tokens: int | None
    model: str
    raw: dict                      # 原始响应,可选保存
```

**要点**:
- 所有 provider 走 `messages` 列表(OpenAI/Anthropic 都是这个模型),避免 provider 专有 API 泄漏到上层。
- Summarizer 只依赖 Protocol,切换 provider = 改一行配置。
- **默认打开 Prompt 缓存(Claude / OpenAI 兼容路径),提高日报稳定性和成本**。

### 4.3 Enricher Protocol

```python
class Enricher(Protocol):
    name: str
    def process(self, events: list[Event], ctx: EnrichContext) -> list[Event]: ...
```

Enricher 串成链,按 `config.toml` 顺序执行。内置几个:`dedupe`(跨源去重)、`cluster_by_pr`(聚合同一 PR 的 open/comment/merge)、`redact`(按规则脱敏)、`tagger`(关键词打标)。

### 4.4 Notifier Protocol

```python
class Notifier(Protocol):
    name: str
    def configure(self, cfg: dict, secrets: SecretResolver) -> None: ...
    def deliver(self, report: Report) -> DeliveryResult: ...
```

Notifier 是**链式**的,一份报告可以同时写文件 + 弹通知 + 发邮件。

### 4.5 插件注册机制

**所有内建实现和第三方插件走同一套 entry_points**:

```toml
# pyproject.toml
[project.entry-points."otter.collectors"]
git      = "otter.collectors.git_local:GitLocalCollector"
github   = "otter.collectors.github:GitHubCollector"
jira     = "otter.collectors.jira:JiraCollector"
chrome   = "otter.collectors.browser_chrome:ChromeCollector"

[project.entry-points."otter.llm"]
claude   = "otter.llm.claude:ClaudeProvider"
openai   = "otter.llm.openai_compat:OpenAICompatProvider"
ollama   = "otter.llm.ollama:OllamaProvider"
mock     = "otter.llm.mock:MockProvider"

[project.entry-points."otter.enrichers"]
dedupe   = "otter.enrichers.dedupe:Dedupe"
cluster  = "otter.enrichers.clustering:PRClustering"
tagger   = "otter.enrichers.tagging:KeywordTagger"

[project.entry-points."otter.notifiers"]
file     = "otter.notifiers.file:FileNotifier"
stdout   = "otter.notifiers.stdout:StdoutNotifier"
macos    = "otter.notifiers.macos:MacOSNotifier"
```

**第三方插件示例**(`otter-plugin-slack`):

```toml
# 独立仓库,pip 可安装
[project.entry-points."otter.collectors"]
slack = "otter_plugin_slack:SlackCollector"

[project.entry-points."otter.notifiers"]
slack = "otter_plugin_slack:SlackNotifier"
```

用户只需 `pip install otter-plugin-slack`,`otter plugins list` 就能看到,`config.toml` 里启用即可 —— **核心代码零改动**。

---

## 5. 数据模型(Event)

```python
# src/otter/core/event.py
from pydantic import BaseModel
from datetime import datetime
from enum import StrEnum

class Ref(BaseModel):
    kind: str                      # "repo", "pr", "issue", "commit", "url", "file", "person"
    id: str                        # 例如 "myorg/repo#123"
    label: str | None = None

class Event(BaseModel):
    id: str                        # 全局唯一:"{source}:{source_id}"
    source: str                    # collector name
    type: str                      # source-defined,如 "commit"、"pr_review"
    timestamp: datetime            # UTC
    actor: str | None = None       # 通常是用户自己,但也可能是 @别人
    title: str
    body: str | None = None
    url: str | None = None
    refs: list[Ref] = []
    metadata: dict = {}            # source-specific,LLM 提示词可选择性使用
    collected_at: datetime
    content_hash: str              # 用于去重
```

**设计取舍**:
- `type` 是字符串而非 enum,新 collector 可以引入新 type 不动核心。
- `metadata` 是 dict 逃生舱,承接 source-specific 字段(如 GitHub 的 `additions`/`deletions`),但**不参与主索引**。
- 强制 `refs` 结构化(而不是塞 metadata),因为聚类和跳转都要用。

---

## 6. 存储层(SQLite Schema)

```sql
-- migrations/001_initial.sql
CREATE TABLE events (
    id             TEXT PRIMARY KEY,           -- "{source}:{source_id}"
    source         TEXT NOT NULL,
    type           TEXT NOT NULL,
    timestamp      INTEGER NOT NULL,           -- unix seconds UTC
    actor          TEXT,
    title          TEXT NOT NULL,
    body           TEXT,
    url            TEXT,
    refs_json      TEXT NOT NULL DEFAULT '[]',
    metadata_json  TEXT NOT NULL DEFAULT '{}',
    collected_at   INTEGER NOT NULL,
    content_hash   TEXT NOT NULL
);
CREATE INDEX idx_events_ts       ON events(timestamp);
CREATE INDEX idx_events_src_ts   ON events(source, timestamp);
CREATE INDEX idx_events_hash     ON events(content_hash);

-- 每个 collector 的运行状态(cursor / last_error / last_run)
CREATE TABLE collector_state (
    source        TEXT PRIMARY KEY,
    last_run_at   INTEGER,
    last_cursor   TEXT,
    last_error    TEXT,
    last_ok_at    INTEGER
);

-- 生成过的报告
CREATE TABLE reports (
    date           TEXT PRIMARY KEY,           -- YYYY-MM-DD
    content_md     TEXT NOT NULL,
    llm_provider   TEXT,
    llm_model      TEXT,
    generated_at   INTEGER NOT NULL,
    event_count    INTEGER,
    prompt_tokens  INTEGER,
    completion_tokens INTEGER,
    trace_path     TEXT                        -- 可选:LLM prompt/response 存档
);

-- LLM 调用轨迹(可选,便于回溯)
CREATE TABLE llm_traces (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    provider      TEXT,
    model         TEXT,
    prompt_hash   TEXT,
    prompt        TEXT,
    response      TEXT,
    duration_ms   INTEGER
);

CREATE TABLE schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
```

**要点**:
- events 表故意用**宽表 + JSON 列**,避免为每个新 source 建新表 —— 这是可扩展性的关键。
- 迁移用最简单的方案:目录里放 `NNN_xxx.sql`,启动时对比 `schema_version` 顺序执行。
- 单进程读写,不开 WAL 也没问题;后期加 CLI 并发再开。

---

## 7. 配置系统(config.toml)

**文件位置**:`./config/config.toml`(POC 阶段项目内路径,便于迁移和查看;MVP 阶段可选切到 `~/.config/otter/`)

```toml
# ./config/config.toml
schema_version = 1

[core]
timezone   = "Asia/Shanghai"
# 相对路径解释为「相对于项目根」,便于整包搬迁
data_dir   = "./data"
report_dir = "./reports"
log_dir    = "./logs"
log_level  = "INFO"

[schedule]
enabled       = true
daily_report  = "0 9 * * *"        # cron,tz 见 [core].timezone
lookback_days = 1                  # 每次总结几天

# ─────────── LLM ───────────
[llm]
provider = "claude"                # 引用下方 [llm.<name>] 段

[llm.claude]
model         = "claude-sonnet-4-6"
api_key_ref   = "keychain:otter/claude"
max_tokens    = 4096
cache_control = false              # 默认关(一天一次不划算),未来接追问式交互再开

[llm.openai]
base_url      = "https://api.deepseek.com/v1"
model         = "deepseek-chat"
api_key_ref   = "keychain:otter/openai"

[llm.ollama]
base_url      = "http://localhost:11434"
model         = "qwen2.5:14b"

# ─────────── 身份 ───────────
[identity]
primary = "guoyang.zou@sap.com"
# aliases = ["me@example.com"]     # MVP 后再加

# ─────────── Collectors ───────────
[collectors.git]
enabled        = true
paths          = ["~/code/*", "~/work/**/*.git"]  # glob
# author_emails 缺省用 [identity].primary + aliases
include_merges = false

[collectors.github]
enabled       = true
username      = "myhandle"
api_key_ref   = "keychain:otter/github"
include_orgs  = ["mycompany"]
event_types   = ["PushEvent", "PullRequestEvent", "PullRequestReviewEvent", "IssueCommentEvent"]

[collectors.jira]
enabled       = false
base_url      = "https://sap.atlassian.net"
# email 缺省用 [identity].primary
api_key_ref   = "keychain:otter/jira"
jql_filter    = "assignee = currentUser()"

# ─────────── Enrichers(顺序敏感)───────────
[enrichers]
pipeline = ["dedupe", "cluster", "redact", "tagger"]

[enrichers.redact]
patterns = ['(?i)password', '(?i)secret_.*']
blocked_refs = ["mycompany/highly-confidential"]

[enrichers.tagger]
rules = [
  { tag = "bugfix", any_of = ["fix:", "bug:", "hotfix"] },
  { tag = "review", any_of = ["review", "LGTM"] },
]

# ─────────── Notifiers ───────────
[notifiers]
pipeline = ["file", "macos"]

[notifiers.file]
# 走 [core].report_dir,可覆盖
filename_template = "{date}.md"

[notifiers.macos]
title = "🦦 Otter · 今日简报"

# ─────────── 提示词(允许覆盖默认模板)───────────
[prompts]
daily = "./config/prompts/daily.md.j2"    # 缺省用内置模板
```

**约定**:
- **`_ref` 结尾的字段是间接引用**,当前只支持 `keychain:xxx` 前缀,未来可加 `env:XXX`、`file:/path`。
- 配置用 pydantic 强校验,启动时报错行号清晰。
- `otter config validate` 命令可预检。

### 7.1 密钥管理(Keychain 抽象)

```python
class SecretResolver(Protocol):
    def resolve(self, ref: str) -> str: ...

# 实现:
# - KeychainResolver("keychain:otter/github")  → 从 macOS Keychain 读
# - EnvResolver("env:GITHUB_TOKEN")            → 环境变量
# - FileResolver("file:/path/to/secret")       → 文件
```

CLI 提供 `otter secret set otter/github` 交互式录入,避免明文出现在 shell 历史。

---

## 8. 主流程(Orchestrator)

```python
def run_daily(target_date: date) -> Report:
    since = local_midnight(target_date, tz)
    until = since + timedelta(days=1)

    # 1. 并行采集(每个 collector 独立线程,失败隔离)
    with ThreadPoolExecutor() as pool:
        futures = {name: pool.submit(collect_one, name, since, until)
                   for name in enabled_collectors()}
        for name, fut in futures.items():
            try:
                store.upsert_events(fut.result().events)
            except CollectorError as e:
                log.warning("collector.failed", name=name, err=e)
                store.record_error(name, e)   # 不阻塞其他

    # 2. 从库里查窗口内事件
    events = store.query(since=since, until=until)

    # 3. 走 enricher pipeline
    events = enricher_pipeline.process(events)

    # 4. 生成 prompt → LLM
    messages = prompt_builder.build(events, template="daily")
    completion = llm.complete(messages)

    # 5. 渲染成 Markdown,存报告
    report = renderer.render(completion, events, target_date)
    store.save_report(report)

    # 6. 通知链
    for notifier in enabled_notifiers():
        try:
            notifier.deliver(report)
        except NotifierError as e:
            log.warning("notifier.failed", name=notifier.name, err=e)

    return report
```

**关键性质**:
- **单个环节失败不阻塞其他**(除了 LLM 是关键路径)。
- **幂等**:同一天重跑 = 覆盖 + 增量补数据。
- **可 dry-run**:`--dry-run` 走 `mock` LLM,不出网。

---

### 8.1 报告风格(v0.1 · 纯 bullet 要点)

**决策**:报告默认走**纯 bullet 要点风格**,不加"教练式"点评。示例:

```markdown
# 🦦 昨日简报 · 2026-08-25(周一)

## 主要工作
- **[PR] myorg/api-gateway #482** 完成 token 刷新逻辑,已合入 main
- **[Jira] ABC-1234** 从 In Progress → In Review;补充了性能测试数据
- **[Commits] payment-service** 3 次提交,聚焦重构 `RefundHandler`

## 沟通与评审
- Review `myorg/webhooks#77`,提了 4 条评论,主要关于错误重试策略
- 参加了 2 场会议(日历数据),标题:「Q3 架构评审」「Onboarding 同步」

## 未完成 / 悬挂
- **[PR] myorg/api-gateway #479** CI 挂了 2 次,未复查
- **[Jira] ABC-1198** 昨日无进展(仍 In Progress),已停留 4 天
- 浏览器高频访问:AWS S3 CORS 文档 → 可能是明天要继续调的问题

## 明日建议
- 优先复查 #479 的 CI 失败
- ABC-1198 停留过久,建议今日 standup 提出或拆小
```

**要点**:
- 4 个固定段:主要工作 / 沟通与评审 / 未完成悬挂 / 明日建议
- 每条 bullet 携带链接(在 Markdown 里)方便一键跳转
- 不写"你今天很努力"这种空话
- 后期可通过 `[prompts]` 段覆盖模板换风格

---

## 9. CLI 命令(Typer)

```
otter init                          # 首次配置向导:生成 config、装 launchd、录密钥
otter doctor                        # 环境自检:Python/权限/API Key/连通性
otter collect [--source=git,github] [--since=1d]
otter report  [--date=today|yesterday|YYYY-MM-DD] [--dry-run]
otter show    [--date=YYYY-MM-DD]   # 打印 / 在编辑器中打开
otter open    [--date=...]          # 用系统默认程序打开 .md
otter config edit                   # $EDITOR 打开 config.toml
otter config validate
otter config path
otter secret set   <ref>
otter secret list
otter plugins list                  # 列出已发现的插件
otter plugins info <name>
otter schedule install | uninstall | status
otter migrate                       # 数据库迁移
```

CLI 层只做参数解析和错误呈现,业务逻辑全在 `core.orchestrator`。

---

## 10. 调度(launchd)

`scripts/com.otter.daily.plist.tmpl` 是模板,`otter schedule install` 会:
1. 读 `[schedule]` 的 cron 表达式
2. 转成 launchd 的 `StartCalendarInterval`
3. 写到 `~/Library/LaunchAgents/com.otter.daily.plist`
4. `launchctl bootstrap gui/$UID …`

好处:即使 Otter 进程没跑,launchd 也能在指定时间唤起。

---

## 11. 隐私与安全

- **数据默认本地**:所有数据留在 `./data`、`./reports`、`./logs`(项目根内),不上传;整包搬到别的 Mac 即完成迁移。
- **LLM 传输前过滤**:`enrichers.redact` 会按规则脱敏,`blocked_refs` 里的事件**不发送**给 LLM(可选保留 title 掩码)。
- **凭证**:全部 Keychain,`config.toml` 里只有引用。
- **审计**:`llm_traces` 表可开可关,便于回看到底把什么内容发出去过。
- **网络白名单**(可选,后期):只允许 LLM 域名出网,采集器只走 localhost 或指定 API。

---

## 12. 可观测性

- **结构化日志**:`./logs/otter.log`,JSON lines,自带轮转。
- **运行状态**:`otter status` 显示每个 collector 的 `last_ok_at` / `last_error`。
- **报告元数据**:`reports` 表记录 tokens/时长/事件数,后期可出周/月成本曲线。

---

## 13. 测试策略

| 层级 | 覆盖点 | 工具 |
|------|--------|------|
| 单元 | Event 归一化、去重、config 校验、prompt 组装 | pytest |
| 集成 | Collector + Store(用 fixture 假 API) | pytest + responses |
| 端到端 | mock LLM 走完主流程 | pytest,`provider=mock` |
| 契约 | 内置 collectors 都符合 Protocol | pytest 参数化 |
| 手动 | `otter doctor` + 真实 API | 每次发布前 |

**契约测试**尤其重要:插件作者可以复用同一套 `tests/contract/test_collector.py` 来验证自己的实现。

---

## 14. 打包与分发

- **依赖管理**:`uv`(比 pip 快 10x,`uv.lock` 精确锁死)
- **CLI 分发路径**:
  - **POC 阶段**:`uv tool install .` (仓库直装)
  - **MVP 阶段**:发到内部 GitHub Release,`scripts/install.sh` 拉预编译
  - **后期**:考虑 `brew tap` 或 PyPI

**可迁移性 checklist**(在 `otter doctor` 里验证):
- Python 3.11+
- Xcode CLT / 完整磁盘访问(Chrome/Safari 采集器需要)
- 网络到 Anthropic API / GitHub / Jira
- Keychain 里目标条目存在
- `./config/config.toml` 通过 schema 校验
- launchd job 已加载(可选)

---

## 15. 版本演进与破坏性变更

- **Event schema** 有 `schema_version`,升级时走数据库迁移。
- **config.toml** 顶部 `schema_version = N`,`otter migrate config` 提供自动升级。
- **插件契约**:如果 Collector Protocol 有破坏性变更,升 `otter` 主版本号,并在 `docs/PLUGIN_DEVELOPMENT.md` 里给迁移指南。
- 内建 collector 也走同一套契约测试,不会有"内部特权 API 但外部插件用不了"的情况。

---

## 16. 已作的默认决策(可推翻)

以下都是我拍的,如果你有不同偏好我们改:

| 决策 | 选择 | 理由 |
|------|------|------|
| 依赖管理 | **uv** | 速度、锁文件、`uv tool install` 一键装 CLI |
| CLI 框架 | **Typer** | 类型注解即命令,自带 --help 美观 |
| 配置格式 | **TOML** + pydantic 校验 | Python 官方(3.11+ tomllib),表现力比 JSON 好 |
| 并发模型 | **同步 + 线程池** | 简单;LLM 调用是瓶颈,async 复杂度不值 |
| 插件发现 | **entry_points** | Python 标准,`pip install` 即注册 |
| 数据库 | **SQLite** + 手写迁移 | 零依赖、便于备份/同步 |
| 提示词 | **Jinja2 模板** | 可覆盖,与代码分离 |
| 存储位置 | **项目根内**(`./data`, `./reports`, `./logs`, `./config`)POC 阶段;MVP 可选切 XDG | 便于整包迁移、cd 进项目即可看数据 |

---

## 17. 已确认的决策(v0.2 补充)

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 数据目录 | **放项目根内**(`./data`, `./reports`, `./logs`, `./config`)· 整包搬迁 = 迁移 |
| 2 | 报告风格 | **纯 bullet 要点**,4 个固定段(见 §8.1);不做"教练式"点评 |
| 3 | 身份聚合 | **MVP 阶段只用 `guoyang.zou@sap.com`**(SAP Jira / 企业 GitHub / Teams 都是同一个)· 未来接个人 GitHub 时再加 `[identity.aliases]` |
| 4 | Prompt Caching | **默认关闭**(`cache_control = false`)· 一天一次的调用间隔远超 5 分钟 TTL,开缓存反而多付 25% 写入费 · 保留开关,后期接"追问式"交互时再打开 |

---

## 18. 下一步(POC 分解)

阶段目标:**7 天内跑通「本地 Git + GitHub → Claude → Markdown」**。

分解:
1. **Day 1**:初始化仓库、pyproject、`otter --version` 跑起来
2. **Day 1-2**:实现 `core/event.py`、`core/config.py`、`core/store.py`(含迁移)
3. **Day 2-3**:实现 `collectors/git_local.py`(用 GitPython 或 subprocess)
4. **Day 3-4**:实现 `collectors/github.py`
5. **Day 4-5**:实现 `llm/claude.py` + `llm/mock.py` + prompt 模板
6. **Day 5-6**:实现 `orchestrator` + `cli.py`(至少 `collect`、`report`、`show`)
7. **Day 6-7**:`otter doctor`、`otter secret set`、README

**成功标准**:连续用 3 天,每天早上一份 Markdown 报告,内容覆盖当日 80%+ 的 Git/GitHub 活动,且没写重复。
