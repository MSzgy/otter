# 个人工作助理 · 需求与功能梳理

> 起草日期:2026-08-26 · 更新:2026-08-26 (v0.3 · 命名确定)
> 项目代号:**Otter 🦦**(CLI:`otter`,短别名 `ot`)
> Slogan 备选:"像水獭一样,躺着也能把活干了。"

---

## 1. 项目背景与动机

作为一名日常在多个工具间频繁切换的开发者/知识工作者(浏览器、Teams、Jira、GitHub、IntelliJ IDEA 等),存在以下痛点:

- **上下文碎片化**:每天的工作痕迹散落在 5+ 个工具中,难以复盘。
- **切换成本高**:第二天早上重新进入状态,需要 20~40 分钟"找回昨天在干嘛"。
- **任务遗漏**:未完成的思路、待跟进的 PR/评论、临时中断的调试,容易被遗忘。
- **缺乏结构化沉淀**:每日工作没有沉淀成可检索、可回顾的记录。

**核心目标**:打造一个跑在 Mac 上的私人助理,自动(或半自动)收集工作痕迹,每天早晨生成前一天工作总结,并给出"从哪里继续"的建议。

---

## 2. 用户画像

- **主用户**:文档作者本人(单用户,不做多租户)。
- **技术水平**:熟悉命令行、能配置 API Key 和权限,能接受 CLI/半自动交互。
- **隐私偏好**:数据默认本地保存,尽量不上云;调用 LLM 时可控制传输内容的粒度。

---

## 3. 功能范围

### 3.1 核心功能(MUST HAVE)

| # | 功能 | 描述 |
|---|------|------|
| F1 | **工作痕迹采集** | 从多个数据源采集当日活动记录,归一化为统一事件流 |
| F2 | **每日总结** | 每天早上定时(或手动触发)生成前一天摘要 |
| F3 | **续接建议** | 基于未完成事项/最近上下文,给出"今天从哪里开始"的建议 |
| F4 | **本地存储与查询** | 所有采集数据本地存储,支持按日期/来源/关键词检索 |

### 3.2 增强功能(NICE TO HAVE,后期)

- 周报/月报自动生成
- 关键事件打标签(bug 修复、需求评审、代码审查等)
- 与日历/待办事项(Reminders、Things、Todoist)双向同步
- 语音简报("早,昨天你做了…")
- 情绪/工作强度分析(工作时长、切换频率)
- 检索式问答:"上周三我在改哪个模块?"

### 3.3 明确排除(OUT OF SCOPE)

- 团队协作、共享(暂不做多用户)
- 网页/移动端(仅 macOS)
- 屏幕录制或全屏 OCR(隐私风险大,MVP 不涉及)
- 主动干预(如自动回复 Teams 消息)
- **Teams 集成(MVP 阶段先绕过)**:企业授权复杂,后期再考虑,MVP 提供"手工粘贴关键聊天"的兜底方式

---

## 4. 数据源分析

以下是候选数据源及其可行性初判(需在 POC 阶段实测):

| 数据源 | 采集方式 | 可行性 | 备注 |
|--------|---------|-------|------|
| **浏览器历史**(Chrome/Safari/Arc) | 读取本地 SQLite(`~/Library/Application Support/...`) | 高 | Chrome 需处理 profile;Safari 需完整磁盘访问权限 |
| **GitHub 活动** | REST/GraphQL API + PAT | 高 | 拉取 commits、PR、review、issue 事件 |
| **Jira 活动** | REST API + PAT/OAuth | 高 | 拉取 issue 变更、评论、状态流转 |
| **IntelliJ IDEA** | 读取 `~/Library/Logs/JetBrains/*/idea.log`、Local History、`recentProjects.xml` | 中 | 无官方 API,靠日志+文件系统 |
| **Teams 聊天** | ❓ | 低~中 | 官方 Graph API 需企业授权;本地缓存路径可能加密。**MVP 建议先跳过或手工粘贴** |
| **本地 Git 仓库** | 遍历常用目录,`git log --author=me --since=yesterday` | 高 | 无需授权,信息量大 |
| **日历**(Calendar.app) | EventKit / AppleScript | 中 | 需授权,可拿到会议标题、参与人 |
| **剪贴板历史** | 需第三方(Maccy)或自建监听 | 低 | 隐私风险,MVP 不做 |
| **应用使用时长** | `log stream` 或 ScreenTime DB | 中 | 需完整磁盘访问 |

**MVP 数据源优先级**:GitHub → 本地 Git → Jira → 浏览器历史 → IDEA → 日历 → Teams

---

## 5. MVP 范围建议

面向 POC/MVP,建议先做一个**最小闭环**:

**输入**(采集 3 个源):
1. 本地 Git 仓库的当日 commits
2. GitHub 当日活动(commits/PR/review/comment)
3. Jira 当日活动(assigned to me 的变更)

**处理**:
- 归一化为 `Event { time, source, type, title, url, snippet }`
- 存入本地 SQLite
- 通过 Claude API 生成 Markdown 格式的日报和续接建议

**输出**:
- 早上 9:00(可配置)在终端 / macOS 通知中心 / 菜单栏 弹出简报
- 简报文件写入 `~/Otter/reports/YYYY-MM-DD.md`
- 支持命令 `otter report` 手动重跑,`otter yesterday` 打开昨日报告

**先不做**:
- Teams 集成
- 图形化界面(先 CLI + 菜单栏图标)
- 复杂的隐私脱敏

---

## 6. 技术选型(已确认)

- **语言/运行时**:**Python 3.11+**(依赖 uv 或 pipx 管理,便于跨机迁移)
- **交互形态**:
  - **阶段 1(POC)**:纯 CLI + launchd 定时任务
  - **阶段 2(MVP)**:加菜单栏图标(`rumps`)+ macOS 通知(`pync` 或 `osascript`)
- **LLM 接入**:**可配置化**(见 §6.1),默认 Claude Sonnet 4.6,支持切换其他模型
- **存储**:本地 SQLite(`~/Library/Application Support/Otter/data.db`)
- **配置驱动**:所有可变项(数据源、时间、LLM、提示词、脱敏规则)都通过 `~/.config/otter/config.toml` 管理,不硬编码
- **可迁移性**:提供一键安装脚本 `install.sh` + `otter init`,在任意 Mac 上快速部署

### 6.1 LLM 可配置策略

`config.toml` 中通过 provider 字段切换,预留以下适配器:

| Provider | 场景 | 备注 |
|----------|------|------|
| `claude` | 默认,质量最好 | 用户提供 API Key,`claude-sonnet-4-6` 起步 |
| `openai` | 备选 | 兼容 OpenAI 协议的服务(含 Azure OpenAI、DeepSeek 等) |
| `ollama` | 完全离线 | 本地跑 llama3/qwen 等,牺牲质量换隐私 |
| `mock` | 开发测试 | 返回假数据,不消耗额度 |

所有 provider 走统一接口 `Summarizer.summarize(events, prompt_template) -> str`,便于替换。

### 6.2 可迁移性设计

目标:**换一台 Mac,10 分钟内跑起来。**

- 单一入口安装:`curl … | bash` 或 `brew install <tap>/<name>`(后期)
- 配置与凭证分离:配置文件可 git 管理,凭证走 Keychain
- 数据目录可指定(`XDG_DATA_HOME` 或配置项),便于走 iCloud/Syncthing 同步
- 依赖锁死:`uv.lock` / `requirements.txt` 纳入仓库
- `otter doctor` 命令自检环境(Python 版本、权限、API Key、数据源连通性)

---

## 7. 架构草图

```
┌─────────────────────────────────────────────────┐
│                   Collectors                    │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐ │
│  │ GitHub │  │  Jira  │  │  Git   │  │Browser │ │
│  └────┬───┘  └────┬───┘  └────┬───┘  └────┬───┘ │
└───────┼──────────┼───────────┼───────────┼──────┘
        └──────────┴───────────┴───────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  Normalizer +     │
              │  Local SQLite     │
              └─────────┬─────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  Summarizer       │  ← Claude API
              │  (LLM prompt)     │    (Claude Sonnet 4.6)
              └─────────┬─────────┘
                        │
                        ▼
              ┌───────────────────┐
              │  Reporter         │
              │  · Markdown       │
              │  · 通知 / 菜单栏  │
              │  · CLI            │
              └───────────────────┘
```

---

## 8. 隐私与安全

- **默认本地优先**:所有原始数据存 `~/Otter/`,不上传。
- **LLM 传输控制**:发送到 Claude API 前允许配置脱敏规则(如屏蔽指定关键词/仓库)。
- **凭证管理**:GitHub/Jira PAT 存 macOS Keychain,不落盘明文。
- **可审计**:每次调用 LLM 的 prompt 和响应可选保存,方便回看。

---

## 9. 里程碑与验收标准

### M1 · POC(目标:1 周内)
- [ ] 至少接入 GitHub + 本地 Git 两个数据源
- [ ] 能生成一份可读的昨日总结 Markdown
- [ ] 通过 CLI `otter report` 手动触发

**验收**:连续 3 天使用后,总结准确覆盖 80% 以上工作项。

### M2 · MVP(目标:M1 后 2-3 周)
- [ ] 加入 Jira + 浏览器历史
- [ ] launchd 定时任务
- [ ] 菜单栏图标 + macOS 通知
- [ ] "续接建议"能给出至少 1 条有价值的行动项

**验收**:早上 9 点开电脑,3 分钟内看完总结就能开始工作。

### M3 · 打磨(目标:M2 后)
- [ ] 加入 IDEA、日历
- [ ] 探索 Teams 集成方案
- [ ] 周报生成

---

## 10. 已确认的决策(v0.2)

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | 技术栈 | **Python**(CLI 起步,后期加菜单栏) |
| 2 | LLM | **可配置化**,默认 Claude Sonnet 4.6,支持 OpenAI 兼容协议 / Ollama 本地 / mock |
| 3 | Teams | **MVP 阶段先绕过**,后期再评估 |
| 4 | 触发时机 | **可配置**(`config.toml` 中设定 cron 表达式,默认 09:00) |
| 5 | 报告形式 | **Markdown**(`~/WorkAssistant/reports/YYYY-MM-DD.md`),后期再加通知/菜单栏 |
| 6 | 部署 | **单机 Mac,但强调可迁移性**:一键安装脚本 + 配置文件驱动 + 依赖锁死,任意 Mac 10 分钟内可跑 |
| 7 | 名字 | **Otter 🦦**(CLI `otter`,slogan「像水獭一样,躺着也能把活干了」) |

## 11. 项目命名 · Otter 🦦

**含义**:水獭是"躺着工作"的经典意象 —— 仰泳漂在水面,肚子上放着石头和贝壳,不慌不忙地敲敲打打就把饭吃了。契合本项目的目标:**让每天早上进入工作状态像水獭吃早餐一样轻松**。

**规范**:
- 项目正式名:`Otter`
- 主 CLI:`otter`(短别名 `ot`)
- Python 包名:`otter_assistant`(避免与 PyPI 上已存在的 `otter` 冲突,发布时确认)
- 数据目录:`~/Otter/` · 配置目录:`~/.config/otter/` · 应用支持:`~/Library/Application Support/Otter/`
- 图标/表情占位:🦦

---

## 12. 下一步建议

1. **本文档过一遍**,回答第 10 节的问题,或直接改写本文档。
2. 选定 POC 技术栈后,创建 `pocs/` 目录,先跑通 GitHub 采集 + Claude 总结的最小链路。
3. POC 通过后,再进入 MVP 的架构与代码组织。
