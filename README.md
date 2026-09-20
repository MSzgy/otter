# 🦦 Otter — 私人 Mac 工作助理

> 像水獭一样,躺着也能把活干了。

Otter 每天定时采集你散落在多个工具里的工作痕迹(本地 Git commits、GitHub PR/review/评论、后续可扩展 Jira / 浏览器 / IntelliJ …),交给 LLM 生成一份中文 Markdown 简报,告诉你「昨天干了啥」和「今天从哪儿接着干」。

**状态**:MVP 完成 · 203 tests green · 可日常使用

---

## 特性

- **插件化架构**:Collectors / LLM providers / Enrichers / Notifiers 全部走 `entry_points`,加新数据源=加一个包,不改核心
- **本地优先**:数据落在本机 SQLite,密钥走 macOS Keychain,LLM 支持自建代理
- **幂等采集**:同一事件多次采集会去重,可以随时重跑当日
- **LangGraph 编排**:声明式 DAG,方便未来加 enricher、反思、多 agent
- **Rich CLI**:`otter doctor` 自检一条龙,配错第一时间给人话报错

---

## 桌面水獭（新增）

现在可以在 macOS 上运行桌面水獭，点击查看/生成工作简报，显示任务状态并在完成时通知。默认离线演示，可在设置中连接现有 Otter 配置，或直接填写 OpenAI 兼容接口的地址、模型名和 API Key，测试后保存启用。现在支持与水獭进行多轮流式聊天，点击桌面水獭或侧栏“与水獭聊天”即可进入；新增本地摸头、喂食、玩球、跳舞、挥手、挠痒和睡眠互动，可从“陪伴互动”或水獭右键菜单操作。新增“应用感知”页，可选择开启 Mac 运行应用、前台应用与浏览器当前标签页感知。生活助手现已加入提醒/专注、工作现场保存恢复、待办和确认执行操作；聊天支持按键语音输入与系统朗读。原生权限与验证边界见桌面文档，硬件接入仍为后续方向。

```bash
uv sync --extra dev
cd desktop
npm ci
npm start
```

详见 [桌面启动、打包与验证](docs/desktop/README.md)。原有 CLI 继续可用。

---

## 快速开始

前置:macOS + [uv](https://github.com/astral-sh/uv)(`brew install uv`)。

```bash
# 1. 装依赖
uv sync

# 2. 造 config
cp config/config.example.toml config/config.toml
$EDITOR config/config.toml            # 至少改 identity.primary 和 collectors.git.paths

# 3. 把密钥写进 Keychain
uv run otter secret set keychain:otter/claude       # Claude API key(如用 claude provider)

# GitHub 授权:两种方式二选一
uv run otter github auth                            # 复用 gh CLI 走浏览器,推荐(需先 brew install gh)
# 或手动:otter secret set keychain:otter/github,粘贴一个 PAT

# Outlook 授权:MSAL device flow 走浏览器,拿到的 refresh_token 存 Keychain
uv run otter outlook auth                           # 完成后把 config 里 [collectors.outlook].enabled 改成 true

# 4. 自检
uv run otter doctor
# ✓ config / 目录 / DB / collectors / LLM / 密钥 全绿再进下一步

# 5. 采集 + 生成
uv run otter collect                                # 采集当日事件
uv run otter report                                 # 基于 Store 生成昨天的简报
uv run otter show                                   # 打印最近一份

# 一步到位:采集当日 + 生成当日简报
uv run otter report --date 2026-08-26 --collect
```

---

## 命令一览

| 命令 | 说明 |
|---|---|
| `otter collect [--date YYYY-MM-DD]` | 采集指定日的事件入库(默认今天) |
| `otter collect --since ISO --until ISO` | 采集自定义窗口(需带时区) |
| `otter report [--date] [--collect] [--llm mock]` | 生成 Markdown 简报;`--collect` 顺便先采一遍;`--llm` 临时覆盖 provider |
| `otter show [--date] [--list N]` | 查看已生成的简报;`--list` 列最近 N 条 |
| `otter doctor` | 自检 config / DB / 插件 / 密钥 |
| `otter secret set <ref>` | 写 Keychain(交互输入,不留 shell 历史) |
| `otter secret get <ref> [--check-only]` | 读 / 验证密钥 |
| `otter secret delete <ref>` | 从 Keychain 删除 |
| `otter github auth` | 通过 `gh` CLI 拿 GitHub token,自动写 Keychain。首次运行会开浏览器登录 |
| `otter outlook auth` | 通过 MSAL device flow 授权 Microsoft Graph,refresh_token 写 Keychain。首次运行会开浏览器 |
| `otter --config PATH ...` | 用非默认路径的 config.toml |

**退出码**:0 成功;1 运行时失败;2 参数错;3 部分 collector 失败(已入库成功的部分)。

---

## 架构

```
┌─────────────────────────── Orchestrator (LangGraph) ────────────────────────────┐
│                                                                                 │
│           ┌─ collect_git   ─┐                                                   │
│  START ───┤─ collect_github ├─→ persist ─┬─→ END (仅 collect)                   │
│           └─ … (fan-out)   ─┘             │                                     │
│                                           └─→ render → llm → save → END          │
│                                                                                 │
└────────────────────┬────────────────────────────────────────────┬───────────────┘
                     ↓                                            ↓
                  Store (SQLite)                          Notifier pipeline
                  events / reports / llm_traces           file / stdout / …
```

### 核心模块

| 位置 | 职责 |
|---|---|
| `src/otter/cli.py` | Typer + Rich 命令入口,重业务通过 lazy import 避免拖启动 |
| `src/otter/core/config.py` | Pydantic 强 schema + 插件段保留 dict(可扩展性关键) |
| `src/otter/core/store.py` | SQLite:events / reports / collector_state / llm_traces。`event.id + content_hash` 幂等 |
| `src/otter/core/registry.py` | 4 组 `PluginRegistry`,懒加载 `entry_points` |
| `src/otter/core/keychain.py` | `keychain:` / `env:` / `file:` 三种 secret 引用 |
| `src/otter/core/orchestrator.py` | LangGraph 编排:动态 fan-out collectors、失败隔离 |
| `src/otter/collectors/` | 内建:`git_local`、`github`、`outlook` |
| `src/otter/llm/` | 内建:`claude`、`mock` |
| `src/otter/summarizer/renderer.py` | Jinja2 模板渲染 prompt(system + user) |
| `src/otter/notifiers/` | 内建:`file`(写副本到 vault)、`stdout` |
| `src/otter/migrations/` | 顺序执行的 `NNN_*.sql`,状态在 `schema_version` |

### 数据流

1. **collect**:每个 collector 是 graph 里独立节点,并行 fan-out;单个失败只在 state 里记 `last_error`,不影响其他
2. **persist**:合并所有 source 的 events,一次 `upsert_events`(`event.id` + `content_hash` 幂等)
3. **render**:重新从库里 `query_events(since, until)`(避免用内存里已去重的),按 source 分组渲染 prompt
4. **llm**:调 provider,把 request / response / duration / tokens 落到 `llm_traces` 表(便于事后审计)
5. **save**:写 md 到 `config.core.report_dir / {date}.md`,元数据入 `reports` 表
6. **notifier pipeline**:按顺序调用各 notifier;单个失败只 warn 不中断

---

## 配置参考

见 [`config/config.example.toml`](config/config.example.toml)。要点:

- **`[core].timezone`**:所有本地日期以此计算;`otter collect --date 2026-08-26` 表示 `[00:00, 次日 00:00)` 本地窗口
- **`[identity]`**:`primary` + `aliases`,Git collector 用它过滤自己的 commit
- **`[llm]`**:`provider = "claude" | "mock"`;`[llm.claude]` 子表放 API key、base_url、model
- **`[collectors.<name>]`**:`enabled` + 各自参数;`*_ref` 字段自动解析为 secret
- **`[notifiers]`**:`pipeline` 是**顺序执行**的名字数组,`[notifiers.<name>]` 是每个的子配置
- **`[prompts].daily`**:覆盖内置 prompt 模板(路径相对 project root)

### Secret 引用

任何配置字段名以 `_ref` 结尾且值为字符串,都会当作 secret 引用解析:

- `keychain:otter/claude` — macOS Keychain(service=`otter`, account=`claude`)
- `env:GITHUB_TOKEN` — 环境变量
- `file:~/.otter/token` — 文本文件(自动 strip 换行)

只有 `keychain:` 走 `otter secret set` 写入;`env:` 请 `export`,`file:` 请自己写文件。

---

## 编写插件

以新增一个 collector 为例:

```python
# my_plugin/otter_ext/ical_collector.py
from typing import Any, ClassVar
from otter.core.event import Event

class ICalCollector:
    name: ClassVar[str] = "ical"

    def __init__(self, *, config: dict[str, Any], resolver, identity: str):
        self._path = config["path"]  # 从 [collectors.ical] 拿

    def collect(self, since, until):
        # yield Event.build(...)
        ...
```

在 `pyproject.toml` 注册:

```toml
[project.entry-points."otter.collectors"]
ical = "otter_ext.ical_collector:ICalCollector"
```

`uv pip install` 之后 `otter doctor` 就能看到,`[collectors.ical]` 段的配置会被自动送进构造函数。**不需要改 otter 源码**。

4 组 entry_points:
- `otter.collectors` — 采集事件
- `otter.llm` — LLM provider
- `otter.enrichers` — Event 后处理(去重、聚类、脱敏、打标)
- `otter.notifiers` — 报告分发(webhook、飞书、邮件……)

各组的 Protocol 契约看 `src/otter/core/{collector,llm,enricher,notifier}.py`。

---

## 定时任务

用 macOS `launchd` 或 `cron` 都行。示例 crontab:

```
# 每天 09:03 生成昨天的简报(采集 + 报告一条龙)
3 9 * * *  cd ~/AI_Work_assistant && /opt/homebrew/bin/uv run otter report --collect >> logs/cron.log 2>&1
```

时间设在 `[schedule].daily_report` 之外无所谓 —— schedule 段目前是给未来的守护进程模式预留的,MVP 直接靠系统调度器。

---

## 目录结构

```
AI_Work_assistant/
├── src/otter/           # 源码(见上方架构表)
├── config/              # config.toml(gitignore)+ config.example.toml(模板)
├── data/                # SQLite(gitignore)
├── reports/             # 生成的 Markdown 简报(gitignore)
├── logs/                # 运行日志(gitignore)
├── docs/ARCHITECTURE.md # 详细架构文档
├── REQUIREMENTS.md      # 需求梳理
└── tests/               # pytest 单测(203 个)
```

---

## 开发

```bash
uv sync --extra dev
uv run pytest -q                      # 全量测试
uv run pytest tests/unit/test_xxx.py  # 单文件
uv run ruff check src tests           # lint
uv run ruff check --fix               # 自动修
```

---

## 文档

- [REQUIREMENTS.md](REQUIREMENTS.md) — 需求梳理与场景
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构细节

## 许可

MIT
