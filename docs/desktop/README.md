# Otter Desktop

首批实现（P0/P1）：macOS 桌面水獭、菜单栏驻留、简报列表与阅读、调用已有简报流程、后台任务状态、安静模式与配置选择。文字聊天、提醒、语音和硬件尚未实现，见 [路线图](ROADMAP.md)。

## 本地启动

需要 macOS、Node.js 22.12+、uv。首次准备：

```bash
uv sync --extra dev
cd desktop
npm ci
npm start
```

初次启动打开控制面板，屏幕角落出现水獭。点击水獭打开面板；按住拖动。关闭面板仍驻留，菜单栏可以隐藏水獭、切换安静模式或退出。退出会结束后台任务；本批尚不提供系统定时调度。

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

模型和数据源的详细参数仍使用原有 TOML 与 CLI 管理，包括 `otter secret`、GitHub/Outlook 授权。桌面不把密钥送到渲染页面。

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
