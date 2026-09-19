# Otter Desktop

首批实现（P0/P1）：macOS 桌面水獭、菜单栏驻留、简报列表与阅读、调用已有简报流程、后台任务状态、安静模式与配置选择。文字聊天已接入 OpenAI 兼容模型；提醒、语音和硬件尚未实现，见 [路线图](ROADMAP.md)。

## 本地启动

需要 macOS、Node.js 22.12+、uv。首次准备：

```bash
uv sync --extra dev
cd desktop
npm ci
npm start
```

初次启动打开控制面板，屏幕角落出现水獭。点水獭身体打开聊天，点头顶摸头，右键打开互动菜单；按住拖动。关闭面板仍驻留，菜单栏可以隐藏水獭、切换安静模式或退出。退出会结束后台任务；本批尚不提供系统定时调度。

默认使用独立的离线演示工作区，模拟模型不读真实记录、不调用付费 API。演示报告全程标注，不会伪装成个人数据。

## 连接现有 Otter

在偏好设置选择原有 `config.toml`，随后选择它对应的项目根目录。相对 data/report/collector 路径继续相对此根目录解释；不会复制或改写原有配置、数据库或密钥。下一次启动沿用选择。报告生成会写入所选配置的数据目录，执行原有 notifier 管线，并可能调用已配置的付费模型。

也可显式启动：

```bash
OTTER_DESKTOP_CONFIG=/absolute/path/config/config.toml \
OTTER_PROJECT_ROOT=/absolute/path/otter \
npm start
```

环境变量优先于界面配置；使用这种启动方式时，切换配置按钮禁用。`OTTER_PYTHON` 可覆盖开发时 Python 可执行文件，默认使用仓库 `.venv/bin/python`。

首次生成默认只使用已入库事件；需要采集时勾选“生成前采集已启用的数据源”。查看历史不触发模型调用。部分 collector 失败会保留成功结果并明确提示，全部失败也会提示失败的数据源，不将结果当作完整报告。

数据源及 Claude 等原有模型的详细参数仍使用 TOML 与 CLI 管理，包括 `otter secret`、GitHub/Outlook 授权。桌面不把密钥送到渲染页面。

## 场景附件与快捷提问（0.5.0）

- 应用感知页点击“聊聊当前场景”，或聊天页点击“附带当前场景”。缓存会明确标注采样时间、最近的外部应用及标签页，不能把标题/网址当正文。先进入可编辑附件预览，发送时才上传。
- 预览支持移除、编辑，以及解释/翻译/提炼重点的提示词。发送后上下文随本机聊天记录保存；新对话不会自动带入旧对话上下文。
- 默认快捷键：⌘⇧Space 呼出聊天；⌘⇧E 读取原应用选中文字并进入预览。可以在偏好设置修改或关闭，注册冲突会提示。
- 选区读取使用 AXSelectedText，不模拟复制，不读取剪贴板，受保护输入框不读取。需要用户在 macOS 辅助功能设置允许 Otter/选区助手；没有选区或应用不支持时会提示，不能宣称已读到内容。
- 未发送附件只在内存保留约 10 分钟，切换/重连工作空间会清空。发送的上下文上限 5000 字符，选区最多 3500 字符。
- 原生选区助手通过 `npm run bundle:native` 构建，需要 macOS Xcode Command Line Tools；启动/打包命令会自动执行，分发包内置助手。

## Mac 应用与浏览器感知（0.4.0）

入口：侧栏“应用感知”。默认关闭，需分别开启应用感知与浏览器感知。设置记住后，下一次启动按开关状态运行。

- **应用感知**：通过 macOS NSWorkspace 获取普通桌面应用列表、应用名称/标识/PID，以及前台应用。约每 4 秒采样，也可以手动刷新。这表示运行中的应用，不保证每个应用都有可见窗口。
- **浏览器感知**：支持 Safari、Google Chrome、Microsoft Edge、Brave 的当前窗口选中标签页。开启后，浏览器处于前台时自动采样；也可在面板手动读取运行中的浏览器，无需把浏览器切到前台。不读取所有标签页、历史记录或页面正文。
- **权限**：标签页通过 Apple Events 读取，首次可能出现 macOS 自动化授权。可在“系统设置 → 隐私与安全性 → 自动化”管理。开发版可能显示 Electron，安装包为 Otter；未授权时会提示并暂停自动重试，授权后使用面板按钮重试。应用列表不使用屏幕录制或辅助功能权限。
- **数据边界**：仅在主进程内存与感知面板保留最近结果，不送到 Python/模型，也不保存进数据库或聊天上下文。关闭应用感知立即清空列表和标签页，并取消未完成读取。浏览器开关关闭后清空标签页。
- **网址**：移除凭据、查询参数与片段；非 HTTP(S) 地址不显示。标题和路径仍可能包含个人信息。隐私/无痕窗口没有单独识别，不希望读取时关闭浏览器感知。
- **时效**：面板显示采样时间。进入 Otter 后，之前的浏览器标签页会明确显示“最近读取，当前不在前台”，避免把缓存当作实时前台状态。

此阶段没有网页正文理解或基于屏幕自动执行任务。Firefox 等其他浏览器能出现在应用列表里，但尚未实现标签页适配。

参考：[NSWorkspace 前台应用](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)、[Apple 自动化权限说明](https://support.apple.com/en-euro/guide/mac-help/mchl108e1718/mac)。

## 本地宠物互动（0.3.0）

入口：主面板“陪伴互动”、水獭右键菜单、菜单栏“陪伴互动”。不调用 Python 模型接口，不消耗 API 额度；后台断开时仍可使用。

|操作|表现|
|---|---|
|摸摸头 / 点击头顶|眯眼、爱心、小气泡|
|喂小鱼|抱着小鱼吃，短暂冷却避免重复投喂|
|玩小球|小球弹跳，身体轻轻跃动|
|跳个舞|左右摇摆和音符|
|打招呼|挥动爪子|
|挠痒痒|眯眼、抖动和笑声文字|
|睡一会儿 / 叫醒水獭|闭眼睡眠 / 伸懒腰；睡眠时单击即可唤醒|
|按住拖动|被提起的姿态和气泡；松开后记住位置，不触发聊天|
|鼠标经过|清醒时视线跟随鼠标，透明区域继续点击穿透|

清醒时点身体进入聊天。睡眠状态和互动次数保存在桌面偏好中，重启恢复；短暂动画不跨重启排队。重复动作有冷却，新的有效动作替换当前动作，结束后自动恢复。

安静模式仅控制简报完成通知，与手动睡眠分开。睡眠不关闭聊天或后台任务，互动状态不会作为模型情绪或长期记忆上传。减少动态效果设置下保留静态反馈；隐藏水獭时停止动画绘制。

## 与水獭聊天（0.2.0）

三个入口：主面板侧栏“与水獭聊天”、点击桌面水獭、菜单栏“与水獭聊天”。使用当前工作空间配置的 OpenAI 兼容模型；mock 模式只返回明确标注的离线演示，Claude 原有报告 provider 暂不提供聊天。

- 支持文字流式回复与多轮上下文；Enter 发送、Shift+Enter 换行，中文输入法选词不会误发送。
- 模型回复时水獭显示思考状态。点击“停止回复”取消当前异步请求，关闭连接并阻止迟到内容覆盖下一轮。
- 新建对话、切换最近的会话、确认后删除完整对话均在聊天页操作。重新打开或重连后恢复记录，异常退出的未完成回复标记为中断，不自动重发。
- 会话保存在所选工作空间的 `data_dir/chat.sqlite3`，独立于已有报告数据库。每次最多展示最近 200 条消息 / 约 40 万字符，旧记录仍在数据库中；删除对话会清除其全部消息。
- 发送时只取当前会话最近最多 12 轮、约 24000 字符的完整上下文；已停止或失败的回复不加入下一轮上下文。单条用户消息上限 6000 字符。
- 不自动读取工作事件、邮件或报告，不把聊天送到报告审计表。此版只进行对话，不能执行提醒、发消息或控制硬件。
- 支持 OpenAI SSE `text/event-stream`，也兼容忽略 `stream=true`、返回完整 JSON 的服务。仅支持 Responses API 的服务需另接适配器。

## 在 UI 配置 OpenAI 兼容模型

偏好设置 → 模型配置：填写 API Base URL、模型 ID、API Key，先点击测试连接，再点击保存并启用。适配 `/chat/completions`（非流式），支持标准 Bearer 认证和无密钥本地服务。

- Base URL 通常形如 `https://服务地址/v1`，根域名自动补 `/v1`；已有路径保留，也接受完整 `/chat/completions` 地址。不要在 URL 放密钥。
- 模型 ID 由服务商提供；不同服务支持的 ID 不同。仅支持 Responses API 的服务不适用此适配器。
- 高级参数支持最大输出长度、请求超时，以及 `max_tokens` / `max_completion_tokens` 两种限制参数。某些推理模型需选择后者。
- API Key 存 macOS Keychain；界面只显示“已配置”，不会读取明文回显。留空保留原密钥，仅允许同一服务地址；更换地址需重新输入。无需认证的本地服务可取消勾选“使用 API Key”。
- 测试连接发送固定短消息，不带工作数据、不生成报告，也不自动保存；可能产生少量服务费用。
- 模型覆盖配置按原配置路径与项目根目录隔离，保存在桌面 userData 的 `models/` 下，只含设置及密钥引用。重连、重启后继续生效，不修改原 TOML，旧 CLI 仍使用 TOML 模型。
- 点击“恢复原模型”恢复该工作区原 TOML 的模型；“使用离线演示”切回 mock。

CLI 也可使用新 provider：

```toml
[llm]
provider = "openai"

[llm.openai]
base_url = "https://你的服务地址/v1"
model = "你的模型ID"
api_key_ref = "keychain:otter/openai"
max_tokens = 4096
token_limit_field = "max_tokens"
timeout_sec = 60
```

通过 `otter secret set keychain:otter/openai` 录入密钥；无认证服务可省略 `api_key_ref`。首次运行 UI 连接测试时，macOS 可能要求允许钥匙串访问。

## 存储与生命周期

桌面偏好及演示数据使用 Electron userData 目录（macOS 为 `~/Library/Application Support/otter-desktop` 或打包产品名对应目录，以界面显示为准）。接入原有配置后，工作数据仍在原来位置。单实例窗口、断线错误、手动重连、隐藏停帧、位置记忆和移除显示器后的位置恢复已实现。

长报告在独立 worker 运行，数据库连接在所属线程创建/关闭。桌面每次只生成一份报告，并通过文件锁防止多个桌面 Runtime 同时生成。此锁尚未覆盖独立启动的旧 CLI/cron，因此不要让旧调度任务与桌面同时生成同日简报。任务列表仅在当前 Runtime 内存保存，重连清空；已经保存的报告仍从数据库恢复。退出时给后台 3 秒收尾，超时结束进程，未完成任务需重新生成。

## 打包可双击的 macOS 应用

在目标架构的 Mac 上构建（Apple Silicon/Intel 分别构建）：

```bash
uv sync --extra dev --extra desktop-build
cd desktop
npm ci
npm run bundle:backend
npm run package
```

输出在 `desktop/release/mac*/Otter.app`。Python、SQL 迁移、Jinja 模板、内建插件及其 metadata 一并打包，不要求目标机器装 uv。第三方 Python 插件需要在构建环境安装并显式纳入打包，目前只承诺内建插件。Git collector 仍需要系统 Git；已配置外部代理也需按原方式运行。

本地包未配置开发者证书和公证，不作为已签名的对外发布版本。签名/公证和自动更新属于后续发布工作；不要用关闭系统安全设置的方式分发。

## 验证

```bash
# 仓库根目录
uv run pytest -q
uv run ruff check src tests
cd desktop
npm run build
npm test
npm run test:e2e
```

`test:e2e` 使用 Playwright 启动真实 Electron 和临时演示数据目录，生成并读取报告，检查重新连接后的持久化、安静开关与 IPC 白名单。会短暂显示测试窗口，结束后清理临时数据。截图输出 `output/playwright/`（不入库）。

## 架构

- `src/otter/application/reports.py`：CLI/桌面共享的组装与通知服务。
- `src/otter/runtime/`：逐行 JSON-RPC、报告 worker、任务状态、参数校验。
- `desktop/electron/`：窗口、子进程生命周期、受限 preload IPC。
- `desktop/src/Otter.tsx`：可替换的 Canvas 水獭，隐藏时停止动画，尊重减少动态效果。
- `desktop/src/main.tsx`：真实报告面板与配置入口。

stdin/stdout 是受限控制协议，插件打印全部转至 stderr，stderr 不转发界面。渲染层禁用 Node、启用 context isolation 与 sandbox；报告 Markdown 不执行 HTML，不加载外部图片，链接仅允许 HTTP(S) 并交给系统浏览器。

### 后续硬件接口

当前水獭使用 `Mood`（idle/working/happy/offline/sleeping）与独立渲染组件，业务层不传绘图坐标。下一阶段将其扩展为统一 BodyAdapter（express/perform/stop/capabilities），让动画动作与 ESP32 预设动作共享意图；当前没有实体硬件执行器。
