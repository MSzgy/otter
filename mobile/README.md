# Otter 手机端

iPhone 上看、也能操作 Mac 上的 Otter：今天的提醒、待办和专注，聊天（回复边写边到），交给 Codex 的任务，水獭的状态。目前只在同一个局域网里直连。

## 手机上能做什么

- 发消息（新对话或接着已有的对话）。和在 Mac 上打字走同一条路：先过“理解办事请求”，要建提醒、改设置这类会弹确认卡片，在手机上确认或取消；普通聊天回复边写边到，回复中可以停止。
- 聊天里要用工具（比如派任务给 Codex、在服务器上运行命令）时弹的卡片，手机上也能“允许一次 / 这段对话都允许 / 拒绝”，Mac 上的同一张卡同时消失。有卡片等你时，“聊天”标签上有数字。
- 停止正在做的 Codex 任务；勾掉待办、加新待办。
- 每台手机在 Mac 的 设置 → 手机 里有“可以操作”开关（新配对的默认打开）。关掉后这台手机立刻变成只能看，所有操作都会被 Mac 拒绝。

## 装到自己的 iPhone

1. 在 Mac 上打开 Otter → 设置 → 手机，打开“允许手机连接”。第一次可能会弹 macOS 防火墙询问，选“允许”。
2. 用 Xcode 打开 `mobile/ios/OtterMobile.xcodeproj`。
3. 选中 OtterMobile 这个 target → Signing & Capabilities → Team 选你的 Apple ID（Xcode → Settings → Accounts 里先登录）。免费账号也行，但装上的 App 7 天后要重新装一次；付费开发者账号没有这个限制。
4. 用数据线连上 iPhone（第一次要在手机上打开“开发者模式”），在 Xcode 顶部选中它，点 Run。
5. 打开 App，扫 Mac 上“添加手机”显示的二维码（或用相机扫，会打开 Otter）。手机会问是否允许访问本地网络，选“允许”。

## 结构

```
Mac（desktop/electron）                       iPhone（mobile/ios）
  各处事件 ──► SyncHub（sync-hub.cjs）            SyncStore：打补丁、缓存、解码
                 主题 + 版本号 + 最小补丁                 ▲
               MobileLink（mobile.cjs）  ── WebSocket ──► SyncConnection
                 Bonjour _otter._tcp、配对、            （Network.framework）
                 加密（sync-crypto.cjs）               SyncCrypto（CryptoKit）
```

- **主题**：`status`、`today`、`chat`、`agents`、`otter`（`main.cjs` 里的 `syncSources`）。只发这些，不发应用感知、窗口内容、剪贴板、密码和密钥。
- **增量**：每个主题有版本号；变化先合并 16 ms（聊天 33 ms）再算最小补丁：改字段、按 id 增删列表项、给字符串追加（流式回复只发新增的字）。手机重连时说“我在第几版”，Mac 只补缺的；缺太多才发整份。
- **没人看时不干活**：没有手机连着时 SyncHub 不读也不算；“允许手机连接”关着时不监听端口。
- **请求**：读——某个对话的历史（`history`）、某个任务的详情（`task`）；写（要“可以操作”）——`send`、`confirm`、`dismiss`、`tool`、`stop`、`stopAgent`、`todo`、`addTodo`。写操作在 Mac 上调用的是桌面端自己的同一段代码（`main.cjs` 里的 `conversation` 和 `phoneActions`），所以规划、确认卡片、密码拦截、工具权限都一样。
- **卡片**：`cards` 主题里是等待回答的工具请求；手机或 Mac 任何一边回答后，两边都会消失。

## 加密和配对

- 配对：二维码里是 `otter://pair?d=…`，内含 Mac 的 X25519 公钥、地址、端口、Bonjour 名字和一次性配对码（5 分钟有效，用一次就作废，错 5 次关闭）。
- 每次连接一个来回：手机发 `hello`（自己的长期公钥和临时公钥），Mac 回 `welcome`（临时公钥）。双方用三次 X25519 交换的结果，经 HKDF-SHA256（配对时用配对码做盐，绑定这两条消息）得到两个方向的 AES-256-GCM 密钥。之后每一帧都加密，计数器做 nonce，丢帧、乱序、重放都会解不开，连接直接断开。
- 只有持有双方长期私钥的两端能算出同样的密钥；临时密钥保证前向保密。Mac 的私钥在 `<userData>/mobile/identity.json`（只有你能读），手机的在钥匙串里（仅此设备）。
- 撤销：Mac 上点“撤销”，那台手机立刻断开，之后连不上。

## 性能

- 模拟器上实测（回环网络）：推送延迟中位 35 ms，95% ≤ 42 ms，往返 10 ms；冒烟测试里 40 次变化的 p95 也要求在 100 ms 内。真机走 Wi-Fi 一般再多 5–30 ms。
- App 打开时先显示上次缓存的内容，同时重连补齐；在后台时断开，回到前台立即重连。
- 每 10 秒一次心跳，顺便算往返时间和两端时钟差；手机把延迟统计报给 Mac，显示在 设置 → 手机 里。

## 开发

- Mac 端测试：`node --test electron/sync-hub.test.cjs electron/mobile.test.cjs`；端到端在 `npm run test:e2e`。
- `desktop/scripts/sync-client.cjs` 是 Node 写的“手机”，协议和 Swift 端一致，测试都用它。
- `desktop/scripts/mobile-demo.cjs` 起一个带假数据的 Mac 端（端口 52531），把配对链接写到 `/tmp/otter-mobile-demo/link.txt`，再往 `cmd` 文件里写命令（`todo`、`chat`、`codex`、`theme` 等）来驱动；模拟器里用 `xcrun simctl openurl booted "<链接>"` 配对。
- 图标和水獭图片由 `mobile/ios/tools/make-assets.swift` 从桌面端的 GIF 生成。
