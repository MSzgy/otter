const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  dialog,
  shell,
  Notification,
  globalShortcut,
  powerMonitor,
  clipboard,
  nativeTheme,
} = require("electron");
const fs = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { Backend } = require("./bridge.cjs");
const { Awareness, nativeRead } = require("./awareness.cjs");
const { execFile } = require("node:child_process");
const { ActionGate } = require("./actions.cjs");
const {
  THEMES,
  normalizeTheme,
  themeSource,
  resolvedTheme,
  windowColor,
} = require("./theme.cjs");
const { SettingsRegistry } = require("./settings-registry.cjs");
const { ToolHost } = require("./tool-host.cjs");
const { WebReader } = require("./web-reader.cjs");
const { Extensions, summary } = require("./extensions.cjs");
const { SkillLibrary } = require("./skills.cjs");
const {
  SshManager,
  SshKeychain,
  takePassword,
  explain: explainSsh,
  AUTH: SSH_AUTH,
} = require("./ssh.cjs");
const actionGate = new ActionGate({
  resolveApp: (id) => nativeRead("resolve-app", id),
  execute: (proposal) =>
    proposal.kind === "open_url"
      ? shell.openExternal(proposal.target)
      : new Promise((resolve, reject) =>
          execFile(
            "/usr/bin/open",
            ["-b", proposal.target],
            { timeout: 10000 },
            (error) =>
              error
                ? reject(new Error("应用打开失败，请确认已安装。"))
                : resolve(),
          ),
        ),
});
let awareness;
const { AppContentReader } = require("./app-content.cjs");
let appContentReader;
const { SpeechPlayer } = require("./speech.cjs");
let speechPlayer,
  voiceTranscribing = false,
  lastSpokenTurn = "";
const { AssistantStore } = require("./assistant-store.cjs");
const { TaskAssistant } = require("./task-assistant.cjs");
let assistantStore, taskAssistant;
const { Ambient } = require("./ambient.cjs");
const { HandoffBroker, setupSnippets } = require("./handoff.cjs");
const os = require("node:os");
let ambient = new Ambient(),
  lastAmbientApp = "";
let assistantError = "生活助手尚未就绪。";
const { readPage } = require("./page-reader.cjs");
let pageReading = false;
const {
  ContextDraft,
  buildScene,
  selectionRead,
  selectionDraft,
} = require("./context.cjs");
const contextDraft = new ContextDraft();
let shortcutStatus = {
  enabled: true,
  chat: "CommandOrControl+Shift+Space",
  selection: "CommandOrControl+Shift+E",
  chatRegistered: false,
  selectionRegistered: false,
};
let selectionPending = false;
let contextError = "";
const { PetState, ACTIONS } = require("./pet-state.cjs");
// The physical otter is optional hardware: off by default, and body-serial loads the
// serial library only when it is turned on. observe() never throws.
const { BodyBridge } = require("./body.cjs");
const body = new BodyBridge({
  serial: require("./body-serial.cjs"),
  log: (...args) => console.warn(...args),
});
let petState = new PetState(),
  petEffectTimer;
let pet,
  panel,
  tray,
  backend,
  preferences = {},
  quitting = false,
  switching = false;
let currentHealth = null,
  lastJob = null,
  offlineMessage = "",
  drag = null;
let chatState = null,
  activeView = "reports",
  handoff;
const root = path.resolve(__dirname, "../..");
const page = path.resolve(__dirname, "../dist/index.html");
const prefsPath = () => path.join(app.getPath("userData"), "desktop.json");
function save() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(prefsPath() + ".tmp", JSON.stringify(preferences), {
    mode: 0o600,
  });
  fs.renameSync(prefsPath() + ".tmp", prefsPath());
}
const { EvolutionController } = require("./evolution.cjs");
const evolution = new EvolutionController({
  persist: (value) => {
    const previous = preferences.evolution;
    preferences.evolution = value;
    try {
      save();
    } catch (error) {
      preferences.evolution = previous;
      throw error;
    }
  },
  changed: (snapshot) => {
    body.observe({ type: "evolution.changed", data: snapshot });
    for (const win of [pet, panel])
      if (win && !win.isDestroyed())
        win.webContents.send("otter:event", {
          type: "evolution.changed",
          data: snapshot,
        });
  },
});
function broadcast(event) {
  body.observe(event);
  evolution.observe(event);
  for (const win of [pet, panel])
    if (win && !win.isDestroyed()) win.webContents.send("otter:event", event);
}
function guard(event) {
  if (
    ![pet, panel].some(
      (w) => w && !w.isDestroyed() && w.webContents.id === event.sender.id,
    ) ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error("不允许的窗口请求。");
  let valid = false;
  try {
    valid = fileURLToPath(event.senderFrame.url.split("?")[0]) === page;
  } catch {}
  if (!valid) throw new Error("不允许的页面请求。");
}
function defaultConfig() {
  const demoRoot = path.join(app.getPath("userData"), "demo");
  fs.mkdirSync(demoRoot, { recursive: true });
  const config = path.join(demoRoot, "config.toml");
  if (!fs.existsSync(config))
    fs.writeFileSync(
      config,
      `[core]\ntimezone = "Asia/Shanghai"\n[identity]\nprimary = "demo@otter.local"\n[llm]\nprovider = "mock"\n[llm.mock]\nresponse = """# 欢迎来到 Otter\n\n这是一份离线演示简报，没有读取你的工作记录。\n\n## 我们可以从这里开始\n- 在设置中选择已有的 Otter 配置。\n- 点击生成简报，整理你启用的数据源。\n- 点击桌面上的水獭，随时回到这里。\n\n## 安静地陪你工作\n简报完成后，我会提醒你一次。"""\n`,
      { mode: 0o600 },
    );
  return { config, root: demoRoot };
}
function selection() {
  return process.env.OTTER_DESKTOP_CONFIG
    ? {
        config: path.resolve(process.env.OTTER_DESKTOP_CONFIG),
        root: path.resolve(process.env.OTTER_PROJECT_ROOT || root),
      }
    : preferences.selection || defaultConfig();
}
// macOS appearance and the panel's base colour follow the theme; the page
// itself re-colours from the preferences broadcast.
function applyAppearance() {
  nativeTheme.themeSource = themeSource(preferences.theme);
  if (panel && !panel.isDestroyed())
    panel.setBackgroundColor(
      windowColor(preferences.theme, nativeTheme.shouldUseDarkColors),
    );
}
function themeQuery() {
  return resolvedTheme(preferences.theme, nativeTheme.shouldUseDarkColors);
}
// What chat may change (see settings-registry.cjs). Each write is the settings
// sheet's own action, sent as if from the panel.
const asPanel = (name, value) =>
  panelAction({ sender: panel.webContents }, name, value);
const memorySettings = async () =>
  (await backend.call("memory.get")).settings || {};
const memoryWrite = (key) => async (value) => {
  if (!backend || backend.closed || switching)
    throw new Error("后台尚未就绪。");
  await backend.call("memory.configure", {
    ...(await memorySettings()),
    [key]: value,
  });
};
const ambientWrite = (key) => (value) =>
  asPanel("ambient.configure", { ...ambient.snapshot().config, [key]: value });
const evolutionWrite = (key) => (value) =>
  asPanel("evolution.configure", {
    ...evolution.snapshot().settings,
    [key]: value,
  });
const chatSettings = new SettingsRegistry([
  {
    id: "quiet",
    label: "安静模式",
    type: "switch",
    read: () => !!preferences.quiet,
    write: (value) => asPanel("quiet", value),
  },
  {
    id: "theme",
    label: "主题",
    type: "choice",
    options: [
      { value: "warm", label: "暖阳小窝" },
      { value: "mint", label: "薄荷清晨" },
      { value: "bay", label: "海湾蓝" },
      { value: "night", label: "夜里小窝" },
      { value: "system", label: "跟随系统" },
    ],
    read: () => normalizeTheme(preferences.theme),
    write: (value) => asPanel("theme", value),
  },
  {
    id: "ambient.enabled",
    label: "主动陪伴",
    type: "switch",
    read: () => ambient.snapshot().config.enabled,
    write: ambientWrite("enabled"),
  },
  {
    id: "ambient.cooldownMinutes",
    label: "主动陪伴的最短间隔",
    type: "number",
    min: 1,
    max: 120,
    unit: " 分钟",
    read: () => ambient.snapshot().config.cooldownMinutes,
    write: ambientWrite("cooldownMinutes"),
  },
  {
    id: "ambient.dailyLimit",
    label: "主动陪伴每天最多",
    type: "number",
    min: 1,
    max: 30,
    unit: " 次",
    read: () => ambient.snapshot().config.dailyLimit,
    write: ambientWrite("dailyLimit"),
  },
  {
    id: "shortcuts.enabled",
    label: "全局快捷键",
    type: "switch",
    read: () => !!shortcutStatus.enabled,
    write: (enabled) =>
      asPanel("shortcuts.save", {
        enabled,
        chat: shortcutStatus.chat,
        selection: shortcutStatus.selection,
      }),
  },
  {
    id: "awareness.enabled",
    label: "应用感知",
    type: "switch",
    read: () => awareness.snapshot().enabled,
    write: (enabled) =>
      asPanel("awareness.configure", {
        enabled,
        browserEnabled: enabled && awareness.snapshot().browserEnabled,
      }),
  },
  {
    id: "awareness.browserEnabled",
    label: "浏览器标签页感知",
    type: "switch",
    read: () => awareness.snapshot().browserEnabled,
    write: (browserEnabled) => {
      const { enabled } = awareness.snapshot();
      if (browserEnabled && !enabled) throw new Error("请先打开应用感知。");
      return asPanel("awareness.configure", { enabled, browserEnabled });
    },
  },
  {
    id: "voice.autoSpeak",
    label: "自动朗读新回复",
    type: "switch",
    read: () => preferences.voice?.autoSpeak === true,
    write: (autoSpeak) =>
      asPanel("voice.configure", {
        model: preferences.voice?.model || "whisper-1",
        autoSpeak,
      }),
  },
  {
    id: "body.enabled",
    label: "连接实体水獭",
    type: "switch",
    read: () => preferences.body?.enabled === true,
    write: (enabled) => asPanel("body.configure", { enabled }),
  },
  {
    id: "evolution.enabled",
    label: "任务进化",
    type: "switch",
    read: () => evolution.snapshot().settings.enabled,
    write: evolutionWrite("enabled"),
  },
  {
    id: "evolution.mode",
    label: "工作形态偏好",
    type: "choice",
    options: [
      { value: "auto", label: "自动" },
      { value: "artisan", label: "工匠" },
      { value: "deep", label: "深潜" },
    ],
    read: () => evolution.snapshot().settings.mode,
    write: evolutionWrite("mode"),
  },
  {
    id: "memory.enabled",
    label: "长期记忆",
    type: "switch",
    read: async () => (await memorySettings()).enabled !== false,
    write: memoryWrite("enabled"),
  },
  {
    id: "memory.nickname",
    label: "对你的称呼",
    type: "text",
    max: 40,
    read: async () => (await memorySettings()).nickname || "",
    write: memoryWrite("nickname"),
  },
  {
    id: "memory.tone",
    label: "说话风格",
    type: "choice",
    options: [
      { value: "warm", label: "自然温柔" },
      { value: "concise", label: "简洁直接" },
      { value: "playful", label: "轻松活泼" },
    ],
    read: async () => (await memorySettings()).tone || "warm",
    write: memoryWrite("tone"),
  },
]);
// Otter's own look-ups for the chat model. Read-only, so they run without a
// card; anything that changes data still goes through the confirmation cards.
const lookup = (tool) => ({
  origin: "Otter",
  readOnly: true,
  trusted: true,
  parameters: { type: "object", properties: {} },
  ...tool,
});
const zone = () => currentHealth?.timezone || "Asia/Shanghai";
const statusFilter = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["active", "done", "all"],
      description: "active（默认）、done 或 all",
    },
  },
};
const webReader = new WebReader();
const builtinTools = {
  list: () => [
    // Not a trusted look-up: it reaches out to a website, so each read asks
    // first and the card shows the address.
    {
      name: "otter_read_webpage",
      label: "读网页",
      origin: "Otter",
      readOnly: true,
      description:
        "读取一个公开网页（http 或 https）的标题和正文文字。用户给出网址或网站名、想让你看网页内容时使用；会先请用户确认网址。不能登录、不能提交表单，读不了本机和局域网地址。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "完整网址；用户只说域名时补上 https://",
          },
        },
        required: ["url"],
      },
      run: ({ url }) => webReader.read(String(url || "")),
    },
    // Adds an MCP server the model put together (say, from a service's docs
    // or another app's config). Asks every time, in words, never "for the
    // whole conversation".
    {
      name: "otter_add_mcp_server",
      label: "添加 MCP 服务",
      origin: "Otter",
      alwaysAsk: true,
      description:
        '替用户添加 MCP 服务。config 用 {"mcpServers":{"名字":{...}}}：本机服务写 command、args、env，网络服务写 url（可带 headers）。会弹卡片列出要运行的命令或要连接的地址，用户允许后才添加。命令、包名和网址必须来自用户或服务的官方说明，不要凭记忆猜。',
      parameters: {
        type: "object",
        properties: {
          config: {
            type: "object",
            description: "Claude Desktop 格式的 MCP 配置",
          },
        },
        required: ["config"],
      },
      preview: ({ config }) =>
        summary(
          extensions.preview(JSON.stringify(config ?? null)),
          "这份配置是水獭整理的，请确认命令或网址来自你信任的来源。",
        ),
      run: ({ config }) => {
        const before = new Set(extensions.snapshot().servers.map((s) => s.id));
        const added = extensions
          .add(JSON.stringify(config))
          .servers.filter((s) => !before.has(s.id))
          .map((s) => s.name);
        return `已添加：${added.join("、")}。服务正在启动，几秒后可以在 设置 → 工具与扩展 里看状态；它的工具会在下一条消息里出现。`;
      },
    },
    lookup({
      name: "otter_time",
      label: "看时间",
      description: "现在的日期、星期、时间和时区。",
      run: () =>
        new Intl.DateTimeFormat("zh-CN", {
          timeZone: zone(),
          dateStyle: "full",
          timeStyle: "short",
        }).format(new Date()) + `（${zone()}）`,
    }),
    lookup({
      name: "otter_reminders",
      label: "看提醒",
      description:
        "用户在 Otter 里的提醒。只能查看；要新建或修改提醒，请让用户直接说出要求，Otter 会弹出确认。",
      parameters: statusFilter,
      run: ({ status = "active" }) => {
        if (!assistantStore) throw new Error(assistantError);
        const when = new Intl.DateTimeFormat("zh-CN", {
          timeZone: zone(),
          dateStyle: "medium",
          timeStyle: "short",
        });
        const active = (r) => ["pending", "due"].includes(r.status);
        return assistantStore
          .snapshot()
          .reminders.filter((r) =>
            status === "all"
              ? true
              : status === "done"
                ? !active(r)
                : active(r),
          )
          .slice(0, 40)
          .map((r) => ({
            内容: r.title,
            时间: when.format(r.dueAt),
            状态: r.status,
          }));
      },
    }),
    lookup({
      name: "otter_todos",
      label: "看待办",
      description:
        "用户在 Otter 里的待办。只能查看；要添加或完成待办，请让用户直接说出要求，Otter 会弹出确认。",
      parameters: statusFilter,
      run: ({ status = "active" }) => {
        if (!assistantStore) throw new Error(assistantError);
        return assistantStore
          .snapshot()
          .todos.filter((t) =>
            status === "all" ? true : status === "done" ? t.done : !t.done,
          )
          .slice(0, 60)
          .map((t) => ({ 内容: t.title, 完成: t.done }));
      },
    }),
    lookup({
      name: "otter_settings",
      label: "看设置",
      description:
        "能在聊天里修改的 Otter 设置和现在的值。只能查看；要修改请让用户直接说“打开/关闭/改成……”，Otter 会弹出确认。",
      run: async () =>
        (await chatSettings.rows()).map((r) => ({
          设置: r.label,
          现在: chatSettings.format(r.id, r.current),
        })),
    }),
  ],
};
const toolHost = new ToolHost({
  sources: [builtinTools],
  onChange: (pending) => {
    if (panel && !panel.isDestroyed())
      panel.webContents.send("otter:event", {
        type: "tools.pending",
        data: pending,
      });
  },
});
// MCP servers the user added; their tools join the host once running.
let extensions;
// Skill folders in <userData>/skills; the model loads them with use_skill.
let skills;
// SSH 服务器: saved logins (passwords in the keychain) and ~/.ssh/config.
let ssh;
const PASSWORD_HELD =
  "这条消息里像是有密码，Otter 没有把它发给模型。要保存服务器登录，请打开“理解办事请求”后说“保存服务器 名字：用户@主机 密码：……”，或者到 设置 → SSH 服务器 里填。";
const sshWhere = (h) =>
  `${h.user ? h.user + "@" : ""}${h.host}${h.port !== 22 ? ":" + h.port : ""}`;
// Chat tools for saved servers, offered only when there are some.
const sshTools = {
  list: () => {
    const hosts = ssh?.list() || [];
    if (!hosts.length) return [];
    const server = {
      type: "string",
      enum: hosts.map((h) => h.name),
      description: "服务器名字",
    };
    return [
      {
        name: "ssh_list_servers",
        label: "看服务器",
        origin: "Otter",
        readOnly: true,
        trusted: true,
        description:
          "用户在 Otter 里保存的 SSH 服务器和 ~/.ssh/config 里的主机：名字、地址、登录方式，不含密码。",
        parameters: { type: "object", properties: {} },
        run: () =>
          ssh.list().map((h) => ({
            名字: h.name,
            地址: sshWhere(h),
            登录方式:
              h.source === "config" ? "~/.ssh/config" : SSH_AUTH[h.auth],
            ...(h.note ? { 备注: h.note } : {}),
          })),
      },
      {
        name: "ssh_open_terminal",
        label: "打开终端登录",
        origin: "Otter",
        description:
          "在终端里打开一个已登录到某台服务器的窗口，让用户自己操作。",
        parameters: {
          type: "object",
          properties: { server },
          required: ["server"],
        },
        preview: ({ server }) => {
          const h = ssh.find(server);
          return `在终端里登录 ${h.name}（${sshWhere(h)}）。`;
        },
        run: async ({ server }) => (await ssh.openTerminal(server)).message,
      },
      {
        name: "ssh_run",
        label: "在服务器上运行命令",
        origin: "Otter",
        alwaysAsk: true,
        description:
          "在一台已保存的服务器上运行一行 shell 命令，返回退出码和输出（最多 60 秒）。只做用户要求的事；会改动服务器的命令，先在回复里说明。",
        parameters: {
          type: "object",
          properties: {
            server,
            command: {
              type: "string",
              description: "在服务器上执行的一行命令",
            },
          },
          required: ["server", "command"],
        },
        preview: ({ server, command }) => {
          const h = ssh.find(server);
          if (typeof command !== "string" || !command.trim())
            throw new Error("缺少要运行的命令。");
          return `在 ${h.name}（${sshWhere(h)}）上运行：\n${command}\n\n命令在服务器上执行，可能改动服务器上的东西。`;
        },
        run: async ({ server, command }) => {
          const r = await ssh.run(server, command);
          if (r.code === 255 && !r.stdout)
            throw new Error(explainSsh(r.stderr, r.code));
          return [
            r.timedOut ? "超过 60 秒，已停止。" : `退出码 ${r.code}`,
            r.stdout ? `输出：\n${r.stdout}` : "（没有输出）",
            ...(r.stderr ? [`错误输出：\n${r.stderr}`] : []),
          ].join("\n\n");
        },
      },
    ];
  },
};
const toolsEnabled = () =>
  extensions ? extensions.enabled : preferences.extensions?.tools !== false;
function preferencesPublic() {
  return {
    quiet: !!preferences.quiet,
    hidden: !!preferences.hidden,
    theme: normalizeTheme(preferences.theme),
    config: selection().config,
    envConfig: !!process.env.OTTER_DESKTOP_CONFIG,
  };
}
async function connect() {
  if (switching) return;
  if (taskAssistant?.executing) throw new Error("请等待当前操作完成。");
  taskAssistant?.invalidate();
  evolution.reset();
  switching = true;
  try {
    if (backend) {
      const old = backend;
      backend = null;
      await old.stop();
    }
    contextDraft.clear();
    contextError = "";
    handoff?.reset(
      "Otter 切换了工作空间，请重试。(Otter switched workspaces.)",
    );
    if (panel && !panel.isDestroyed())
      panel.webContents.send("otter:event", {
        type: "context.draft",
        data: null,
      });
    currentHealth = null;
    lastJob = null;
    chatState = null;
    offlineMessage = "";
    broadcast({ type: "connection", data: { status: "connecting" } });
    const selected = selection();
    const command = app.isPackaged
      ? path.join(process.resourcesPath, "backend/otter-runtime/otter-runtime")
      : process.env.OTTER_PYTHON || path.join(root, ".venv/bin/python");
    const args = [
      ...(app.isPackaged ? [] : ["-m", "otter.runtime"]),
      "--config",
      selected.config,
      "--root",
      selected.root,
      "--audio-dir",
      path.join(app.getPath("userData"), "audio-temp"),
      "--model-settings",
      path.join(
        app.getPath("userData"),
        "models",
        createHash("sha256")
          .update(JSON.stringify([selected.config, selected.root]))
          .digest("hex") + ".json",
      ),
    ];
    const child = new Backend(command, args, {
      cwd: app.isPackaged ? app.getPath("userData") : root,
      env: app.isPackaged
        ? process.env
        : { ...process.env, PYTHONPATH: path.join(root, "src") },
    });
    backend = child;
    child.on("offline", (message) => {
      if (backend !== child) return;
      currentHealth = null;
      chatState = null;
      offlineMessage = message;
      broadcast({ type: "connection", data: { status: "offline", message } });
    });
    child.on("event", (event) => {
      if (backend !== child) return;
      if (event.type === "chat.tool-call") {
        // Runs here (asking the user when needed) and answers the backend.
        const call = event.data;
        void toolHost
          .handle(call)
          .then((result) =>
            child.closed
              ? null
              : child.call("chat.tool-result", {
                  call_id: call.call_id,
                  ...result,
                }),
          )
          .catch(() => {});
        return;
      }
      if (event.type === "chat.changed") {
        chatState = event.data;
        if (chatState.status !== "streaming") toolHost.cancelTurn(chatState.id);
        body.observe({
          type: "chat.activity",
          data: { status: chatState.status },
        });
        evolution.observe({
          type: "chat.activity",
          data: {
            id: chatState.id,
            status: chatState.status,
            effort: chatState.effort,
            plannedSteps: chatState.plannedSteps,
          },
        });
        // The pet only needs activity; do not send conversation text to its renderer.
        if (panel && !panel.isDestroyed())
          panel.webContents.send("otter:event", event);
        if (pet && !pet.isDestroyed())
          pet.webContents.send("otter:event", {
            type: "chat.activity",
            data: { status: chatState.status },
          });
        return;
      }
      if (
        event.type === "memory.changed" ||
        event.type === "memory.suggestion-status" ||
        event.type === "projects.changed"
      ) {
        // Only the panel shows memory; the pet never needs it.
        if (panel && !panel.isDestroyed())
          panel.webContents.send("otter:event", event);
        return;
      }
      lastJob = event.data;
      broadcast(event);
      if (event.data.status === "finished") ambientEvent("report");
      if (
        event.data.status === "finished" &&
        !preferences.quiet &&
        !assistantStore?.snapshot().focus &&
        Notification.isSupported()
      ) {
        const note = new Notification({
          title: "Otter · 简报已准备好",
          body: `${event.data.date} 的简报已保存${event.data.warnings?.length ? "，部分数据源需要检查" : ""}。`,
        });
        note.on("click", showPanel);
        note.show();
      }
    });
    currentHealth = await child.call("health.get");
    broadcast({
      type: "connection",
      data: { status: "online", health: currentHealth },
    });
  } catch (error) {
    offlineMessage = error.message;
    broadcast({
      type: "connection",
      data: { status: "offline", message: error.message },
    });
  } finally {
    switching = false;
  }
}
function windowOptions() {
  return {
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
function protect(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const audioOnly =
        permission === "media" &&
        contents === panel?.webContents &&
        details.mediaTypes?.includes("audio") &&
        !details.mediaTypes?.includes("video");
      callback(!!audioOnly);
    },
  );
}
function showPanel() {
  if (panel && !panel.isDestroyed()) {
    panel.show();
    panel.focus();
  }
}
function clampPosition(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    x = 0;
    y = 0;
  }
  const a = screen.getDisplayNearestPoint({
    x: Math.round(x),
    y: Math.round(y),
  }).workArea;
  return {
    x: Math.round(Math.min(Math.max(x, a.x), a.x + a.width - 220)),
    y: Math.round(Math.min(Math.max(y, a.y), a.y + a.height - 250)),
  };
}
function reposition() {
  if (pet && !pet.isDestroyed()) {
    const [x, y] = pet.getPosition();
    const p = clampPosition(x, y);
    pet.setPosition(p.x, p.y);
  }
}
function showChat() {
  activeView = "chat";
  showPanel();
  if (panel && !panel.isDestroyed())
    panel.webContents.send("otter:event", {
      type: "navigation",
      data: { view: "chat" },
    });
}
function showHandoff() {
  activeView = "handoff";
  showPanel();
  if (panel && !panel.isDestroyed())
    panel.webContents.send("otter:event", {
      type: "navigation",
      data: { view: "handoff" },
    });
}
function handoffSetup() {
  const command = app.isPackaged
    ? path.join(process.resourcesPath, "backend/otter-runtime/otter-runtime")
    : process.env.OTTER_PYTHON || path.join(root, ".venv/bin/python");
  const args = app.isPackaged ? ["mcp"] : ["-m", "otter.handoff.mcp_server"];
  const env = app.isPackaged ? {} : { PYTHONPATH: path.join(root, "src") };
  const fallback = path.join(
    os.homedir(),
    "Library/Application Support/otter-desktop/handoff.sock",
  );
  if (handoff.socketPath !== fallback)
    env.OTTER_HANDOFF_SOCKET = handoff.socketPath;
  return {
    packaged: app.isPackaged,
    snippets: setupSnippets({ command, args, env }),
  };
}
function handoffState() {
  return {
    ...handoff.snapshot(),
    enabled: preferences.handoff?.enabled === true,
    setup: handoffSetup(),
  };
}
function handoffNotify(title, body) {
  if (Notification.isSupported()) {
    const note = new Notification({ title, body });
    note.on("click", showHandoff);
    note.show();
  }
  broadcast({ type: "pet.notice", data: { message: body } });
}
function draftToChat(text, label) {
  contextError = "";
  const draft = contextDraft.set(text, label);
  showChat();
  panel.webContents.send("otter:event", { type: "context.draft", data: draft });
  return draft;
}
function selectionExecutable() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native/otter-selection")
    : path.join(root, "desktop/build/native/otter-selection");
}
async function captureSelection() {
  if (selectionPending) return;
  selectionPending = true;
  try {
    const result = await selectionRead(selectionExecutable());
    draftToChat(selectionDraft(result), "选中文字");
  } catch (error) {
    contextError = error.message;
    showChat();
    panel.webContents.send("otter:event", {
      type: "context.error",
      data: { message: error.message },
    });
  } finally {
    selectionPending = false;
  }
}
function registerShortcuts(settings) {
  const config = {
    enabled: settings?.enabled !== false,
    chat: settings?.chat || "CommandOrControl+Shift+Space",
    selection: settings?.selection || "CommandOrControl+Shift+E",
  };
  if (
    typeof config.chat !== "string" ||
    typeof config.selection !== "string" ||
    config.chat.length > 80 ||
    config.selection.length > 80 ||
    config.chat === config.selection
  )
    throw new Error("请设置两个不同的有效快捷键。");
  globalShortcut.unregisterAll();
  let chatRegistered = false,
    selectionRegistered = false;
  if (config.enabled) {
    try {
      chatRegistered = globalShortcut.register(config.chat, () => showChat());
    } catch {}
    try {
      selectionRegistered = globalShortcut.register(
        config.selection,
        () => void captureSelection(),
      );
    } catch {}
  }
  shortcutStatus = { ...config, chatRegistered, selectionRegistered };
  return shortcutStatus;
}
function ambientEvent(kind) {
  const petSnapshot = petState.snapshot();
  const reaction = ambient.event(kind, {
    quiet: !!preferences.quiet,
    focus: !!assistantStore?.snapshot().focus,
    busy: !!petSnapshot.effect || chatState?.status === "streaming",
    sleeping: petSnapshot.asleep,
  });
  if (!reaction) return;
  preferences.ambient = ambient.snapshot();
  save();
  if (reaction.action) {
    try {
      interactPet(reaction.action);
    } catch {}
  }
  broadcast({ type: "pet.notice", data: { message: reaction.caption } });
}
function interactPet(action) {
  const snapshot = petState.interact(action);
  preferences.petState = petState.persisted();
  save();
  broadcast({ type: "pet.changed", data: snapshot });
  clearTimeout(petEffectTimer);
  if (snapshot.effect)
    petEffectTimer = setTimeout(
      () => broadcast({ type: "pet.changed", data: petState.snapshot() }),
      Math.max(0, snapshot.effect.expiresAt - Date.now()) + 20,
    );
  return snapshot;
}
// A tap on the physical otter only does what the app already offers: "知道了" on
// the earliest due reminder, otherwise a head pat (waking the pet first if asleep).
function bodyTapped() {
  const due = (assistantStore?.snapshot().reminders || [])
    .filter((r) => r.status === "due")
    .sort((a, b) => a.dueAt - b.dueAt)[0];
  if (due) return assistantStore.change(due.id, "done");
  interactPet(petState.snapshot().asleep ? "wake" : "pet");
}
// Gives the bridge the current state, which events alone would only cover later.
function seedBody() {
  body.observe({ type: "preferences", data: { quiet: !!preferences.quiet } });
  body.observe({ type: "pet.changed", data: petState.snapshot() });
  if (assistantStore)
    body.observe({
      type: "assistant.changed",
      data: assistantStore.snapshot(),
    });
  body.observe({
    type: "connection",
    data: {
      status: currentHealth
        ? "online"
        : offlineMessage
          ? "offline"
          : "connecting",
    },
  });
  if (chatState)
    body.observe({ type: "chat.activity", data: { status: chatState.status } });
  if (lastJob) body.observe({ type: "job.changed", data: lastJob });
}
body.on("tap", () => {
  try {
    bodyTapped();
  } catch {} // a pet cooldown or a busy store may refuse; the app is unaffected
});
body.on("changed", (snapshot) => {
  if (panel && !panel.isDestroyed())
    panel.webContents.send("otter:event", {
      type: "body.changed",
      data: snapshot,
    });
});
function showPetInteractions() {
  activeView = "pet";
  showPanel();
  if (panel && !panel.isDestroyed())
    panel.webContents.send("otter:event", {
      type: "navigation",
      data: { view: "pet" },
    });
}
function petMenu() {
  const asleep = petState.snapshot().asleep;
  return Menu.buildFromTemplate([
    { label: "与水獭聊天", click: showChat },
    ...Object.entries(ACTIONS)
      .filter(([key]) => key !== (asleep ? "sleep" : "wake"))
      .map(([key, value]) => ({
        label: value.label,
        enabled: !asleep || key === "wake",
        click: () => {
          try {
            interactPet(key);
          } catch (error) {
            broadcast({ type: "pet.notice", data: { message: error.message } });
          }
        },
      })),
    { type: "separator" },
    { label: "打开互动面板", click: showPetInteractions },
    {
      label: "隐藏水獭",
      click: () => {
        preferences.hidden = true;
        pet.hide();
        save();
        refreshTray();
      },
    },
  ]);
}
function refreshTray() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Otter", click: showPanel },
      { label: "与水獭聊天", click: showChat },
      { label: "陪伴互动", click: showPetInteractions },
      { label: "用选中文字提问", click: () => void captureSelection() },
      {
        label: "显示桌面水獭",
        type: "checkbox",
        checked: !preferences.hidden,
        click: () => {
          preferences.hidden = !preferences.hidden;
          preferences.hidden ? pet.hide() : pet.showInactive();
          save();
          refreshTray();
        },
      },
      {
        label: "安静模式（关闭完成通知）",
        type: "checkbox",
        checked: !!preferences.quiet,
        click: () => {
          preferences.quiet = !preferences.quiet;
          save();
          refreshTray();
          broadcast({ type: "preferences", data: preferencesPublic() });
        },
      },
      { type: "separator" },
      { label: "退出 Otter", click: () => app.quit() },
    ]),
  );
}
function ensureIdle() {
  if (
    switching ||
    taskAssistant?.busy ||
    (chatState?.status === "streaming" && backend && !backend.closed) ||
    (lastJob &&
      ["queued", "running"].includes(lastJob.status) &&
      backend &&
      !backend.closed)
  )
    throw new Error("请等待当前任务完成。");
}
ipcMain.handle("otter:call", async (event, method, params) => {
  guard(event);
  if (
    ![
      "health.get",
      "reports.list",
      "reports.get",
      "reports.generate",
      "jobs.list",
      "projects.list",
      "projects.get",
      "projects.save",
      "projects.archive",
      "projects.sources",
      "projects.binding",
      "projects.bind",
      "projects.manual",
      "projects.draft",
      "projects.dismiss",
      "projects.commit",
      "projects.delete-snapshot",
      "projects.handoff-list",
      "projects.handoff-open",
      "projects.handoff-dismiss",
      "memory.get",
      "memory.candidates",
      "memory.ai-configure",
      "memory.accept",
      "memory.dismiss",
      "memory.save",
      "memory.delete",
      "memory.clear",
      "memory.configure",
      "chat.sessions",
      "chat.new",
      "chat.history",
      "chat.send",
      "chat.cancel",
      "chat.delete",
      "chat.state",
      "models.get",
      "models.test",
      "models.save",
      "models.reset",
    ].includes(method)
  )
    throw new Error("不支持的操作。");
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    JSON.stringify(params).length > 64000
  )
    throw new Error("参数无效。");
  if (!backend || switching) throw new Error("后台尚未就绪。");
  // The renderer never chooses tools; the host offers what is enabled,
  // including skills installed in other tools since the last message.
  if (method === "chat.send") {
    if (takePassword(params.text).password) throw new Error(PASSWORD_HELD);
    try {
      skills?.refresh();
    } catch {}
  }
  if (method === "chat.send")
    params = {
      ...params,
      tools: toolsEnabled() ? toolHost.definitions() : [],
    };
  if (
    [
      "models.save",
      "models.reset",
      "chat.send",
      "chat.new",
      "chat.delete",
    ].includes(method) &&
    taskAssistant?.busy
  )
    throw new Error("请先等待或停止当前办事操作。");
  if (
    (method.startsWith("models.") ||
      method.startsWith("chat.") ||
      method.startsWith("memory.") ||
      method.startsWith("projects.")) &&
    event.sender !== panel.webContents
  )
    throw new Error("请在设置面板中配置模型。");
  const result = await backend.call(method, params);
  if (method === "chat.delete") {
    taskAssistant?.forget(params.session_id);
    toolHost.forgetSession(params.session_id);
  }
  if (method === "chat.delete" && chatState?.session_id === params.session_id)
    chatState = null;
  if (["models.save", "models.reset"].includes(method)) {
    taskAssistant?.invalidate();
    currentHealth = await backend.call("health.get");
    broadcast({
      type: "connection",
      data: { status: "online", health: currentHealth },
    });
  }
  return result;
});
ipcMain.handle("otter:action", async (event, name, value) => {
  guard(event);
  return panelAction(event, name, value);
});
// Every renderer action. A setting changed from chat calls this with the panel
// as sender, so it runs exactly what the settings sheet runs.
async function panelAction(event, name, value) {
  if (name.startsWith("tools.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在主面板处理工具请求。");
    if (name === "tools.pending") return toolHost.pending();
    if (name === "tools.decide")
      return toolHost.decide(value?.id, value?.decision);
    throw new Error("不支持的工具操作。");
  }
  if (name.startsWith("extensions.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在设置里管理工具。");
    if (!extensions) throw new Error("工具尚未就绪。");
    if (name === "extensions.get") {
      // Opening the page picks up skills added in other tools since.
      try {
        skills?.scan();
      } catch {}
      return {
        ...extensions.snapshot(),
        builtins: builtinTools.list().map((t) => t.label),
        skills: skills?.snapshot() || null,
      };
    }
    if (name === "extensions.configure")
      return extensions.setTools(value?.tools);
    if (name === "extensions.preview") return extensions.preview(value?.text);
    if (name === "extensions.add") return extensions.add(value?.text);
    if (name === "extensions.server")
      return extensions.setEnabled(value?.id, value?.enabled);
    if (name === "extensions.remove") return extensions.remove(value?.id);
    if (name === "extensions.allow")
      return extensions.setAllow(value?.id, value?.tool, value?.allow);
    throw new Error("不支持的工具设置。");
  }
  if (name.startsWith("ssh.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在设置里管理服务器。");
    if (!ssh) throw new Error("服务器管理尚未就绪。");
    if (name === "ssh.get") return ssh.snapshot();
    if (name === "ssh.save") {
      const password =
        typeof value?.password === "string" && value.password
          ? value.password
          : null;
      await ssh.saveHost(value?.server, { id: value?.id || null, password });
      return ssh.snapshot();
    }
    if (name === "ssh.remove") return ssh.remove(value?.id);
    if (name === "ssh.test") return ssh.test(value?.id);
    if (name === "ssh.open") return ssh.openTerminal(value?.id);
    if (name === "ssh.pick-key") {
      const picked = await dialog.showOpenDialog(panel, {
        title: "选择 SSH 私钥文件",
        defaultPath: path.join(app.getPath("home"), ".ssh"),
        properties: ["openFile", "showHiddenFiles"],
      });
      return picked.canceled ? null : picked.filePaths[0];
    }
    throw new Error("不支持的服务器操作。");
  }
  if (name.startsWith("skills.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在设置里管理 skill。");
    if (!skills) throw new Error("Skill 尚未就绪。");
    if (name === "skills.rescan") return skills.scan();
    if (name === "skills.toggle")
      return skills.setEnabled(value?.name, value?.enabled);
    if (name === "skills.source")
      return skills.setSource(value?.id, value?.enabled);
    if (name === "skills.open") {
      fs.mkdirSync(skills.dir, { recursive: true });
      await shell.openPath(skills.dir);
      return skills.snapshot();
    }
    if (name === "skills.import") {
      const picked = await dialog.showOpenDialog(panel, {
        title: "选择一个 skill 文件夹（里面有 SKILL.md）",
        properties: ["openDirectory"],
      });
      if (picked.canceled) return skills.snapshot();
      return skills.import(picked.filePaths[0]);
    }
    throw new Error("不支持的 skill 操作。");
  }
  if (name.startsWith("projects.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在主面板管理项目。");
    if (!backend || switching) throw new Error("后台尚未就绪。");
    if (name === "projects.continue") {
      ensureIdle();
      const project = await backend.call("projects.get", {
        project_id: value?.projectId,
      });
      if (project.archived) throw new Error("请先恢复已归档项目。");
      const session = await backend.call("chat.new");
      const result = await backend.call("projects.resume", {
        project_id: value?.projectId,
        session_id: session.id,
      });
      await backend.call("tasks.record", {
        session_id: session.id,
        request_id: randomUUID(),
        text: "继续项目",
        result: result.message,
      });
      showChat();
      return session;
    }
    if (name === "projects.todo") {
      if (!assistantStore) throw new Error(assistantError);
      const plan = await backend.call("projects.resolve", {
        kind: "project_todo",
        project_id: value?.projectId,
        item_id: value?.itemId,
      });
      await backend.call("projects.check", plan.project_ref);
      return assistantStore.addTodo(plan);
    }
    throw new Error("不支持的项目操作。");
  }
  if (name.startsWith("tasks.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在聊天面板办事。");
    if (name === "tasks.settings")
      return { enabled: preferences.tasks?.enabled !== false };
    if (name === "tasks.configure") {
      if (typeof value?.enabled !== "boolean")
        throw new Error("办事设置无效。");
      if (taskAssistant?.executing) throw new Error("请等待当前操作完成。");
      const old = preferences.tasks;
      preferences.tasks = { enabled: value.enabled };
      try {
        save();
      } catch (e) {
        preferences.tasks = old;
        throw e;
      }
      taskAssistant?.invalidate();
      return preferences.tasks;
    }
    if (!taskAssistant) throw new Error(assistantError);
    if (name === "tasks.cancel") {
      taskAssistant.cancel(value?.requestId);
      evolution.cancel("task", value?.requestId);
      return;
    }
    if (!backend || backend.closed || switching)
      throw new Error("后台尚未就绪。");
    if (chatState?.status === "streaming")
      throw new Error("请等待当前回复结束。");
    if (name === "tasks.plan") {
      // A password in the message stays here: the planner sees ••••, and
      // only a 保存服务器 card may use it (it then goes to the keychain).
      const { text, password } = takePassword(value?.text);
      if (preferences.tasks?.enabled === false) {
        if (password) throw new Error(PASSWORD_HELD);
        return { kind: "chat" };
      }
      const id = value?.requestId;
      evolution.begin("task", { id });
      try {
        const result = await taskAssistant.plan({
          ...(value || {}),
          text,
          secret: password,
        });
        if (result.kind === "proposal") evolution.wait("task", id);
        else evolution.cancel("task", id);
        return result;
      } catch (error) {
        evolution.finish("task", id, { ok: false });
        throw error;
      }
    }
    if (name === "tasks.undo-setting")
      return taskAssistant.undoSetting(value || {});
    if (name === "tasks.confirm") {
      // Planner proposal IDs differ from the renderer's request ID. A cached
      // receipt for an older proposal must not complete a newer visual task.
      const id =
        taskAssistant.pending && taskAssistant.pending.id === value?.id
          ? taskAssistant.pending.requestId
          : null;
      evolution.resume("task", id);
      try {
        const result = await taskAssistant.confirm(value || {});
        evolution.finish("task", id, {
          ok: result.ok === true,
          verified: result.ok === true,
        });
        return result;
      } catch (error) {
        evolution.finish("task", id, { ok: false });
        throw error;
      }
    }
    throw new Error("不支持的办事操作。");
  }
  if (name === "snapshot")
    return {
      version: app.getVersion(),
      health: currentHealth,
      pet: petState.snapshot(),
      chat:
        event.sender === panel.webContents
          ? chatState
          : chatState
            ? { status: chatState.status }
            : null,
      view: activeView,
      job: lastJob,
      preferences: preferencesPublic(),
      message: offlineMessage,
      switching,
    };
  if (name.startsWith("voice.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在聊天面板使用语音。");
    if (name === "voice.state") return { speaking: !!speechPlayer?.child };
    if (name === "voice.settings")
      return {
        model: preferences.voice?.model || "whisper-1",
        autoSpeak: preferences.voice?.autoSpeak === true,
      };
    if (name === "voice.configure") {
      if (
        typeof value?.model !== "string" ||
        !value.model.trim() ||
        value.model.length > 200 ||
        typeof value.autoSpeak !== "boolean"
      )
        throw new Error("语音设置无效。");
      preferences.voice = {
        model: value.model.trim(),
        autoSpeak: value.autoSpeak,
      };
      save();
      return preferences.voice;
    }
    if (name === "voice.stop") {
      speechPlayer.stop();
      return;
    }
    if (name === "voice.speak") return speechPlayer.speak(value);
    if (name === "voice.reply") {
      if (
        preferences.voice?.autoSpeak &&
        chatState?.id === value &&
        chatState.status === "complete" &&
        lastSpokenTurn !== value
      ) {
        lastSpokenTurn = value;
        return speechPlayer.speak(chatState.content.slice(0, 8000));
      }
      return;
    }
    if (name === "voice.transcribe") {
      if (!backend || switching || voiceTranscribing)
        throw new Error("后台未就绪或正在转写，请稍候。");
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength < 1 ||
        value.byteLength > 2 * 1024 * 1024
      )
        throw new Error("录音为空或超过 2 MB。");
      const dir = path.join(app.getPath("userData"), "audio-temp");
      fs.mkdirSync(dir, { recursive: true });
      const id = randomUUID().replaceAll("-", "");
      const file = path.join(dir, id + ".webm");
      fs.writeFileSync(file, value, { mode: 0o600, flag: "wx" });
      voiceTranscribing = true;
      try {
        return await backend.call("voice.transcribe", {
          file_id: id,
          model: preferences.voice?.model || "whisper-1",
        });
      } finally {
        voiceTranscribing = false;
        fs.rmSync(file, { force: true });
      }
    }
    throw new Error("不支持的语音操作。");
  }
  if (name.startsWith("actions.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在主面板确认操作。");
    if (name === "actions.prepare") return actionGate.prepare(value || {});
    if (name === "actions.confirm") return actionGate.confirm(value);
    if (name === "actions.cancel") {
      actionGate.cancel(value);
      return;
    }
    throw new Error("不支持的操作。");
  }
  if (name.startsWith("ambient.")) {
    if (event.sender !== panel.webContents) throw new Error("请在主面板操作。");
    if (name === "ambient.get") return ambient.snapshot();
    if (name === "ambient.configure") {
      const result = ambient.configure(value);
      preferences.ambient = result;
      save();
      return result;
    }
    throw new Error("不支持的陪伴设置。");
  }
  if (name.startsWith("evolution.")) {
    if (name === "evolution.get") return evolution.snapshot();
    if (event.sender !== panel.webContents)
      throw new Error("请在主面板设置任务进化。");
    if (name === "evolution.configure") return evolution.configure(value);
    if (name === "evolution.demo.start")
      return evolution.startDemo(value?.form);
    if (name === "evolution.demo.continue") return evolution.continueDemo();
    if (name === "evolution.demo.fail") return evolution.failDemo();
    if (name === "evolution.demo.stop") return evolution.stopDemo();
    if (name === "evolution.skip") return evolution.skipLive();
    if (name === "evolution.demo.skip") return evolution.skipDemo();
    if (name === "evolution.milestone")
      return evolution.recordMilestone(value?.id);
    throw new Error("不支持的进化操作。");
  }
  if (name.startsWith("body.")) {
    if (event.sender !== panel.webContents) throw new Error("请在主面板操作。");
    if (name === "body.get") return body.snapshot();
    if (name === "body.configure") {
      preferences.body = { enabled: value?.enabled === true };
      save();
      seedBody();
      return body.configure(preferences.body);
    }
    throw new Error("不支持的实体水獭设置。");
  }
  if (name.startsWith("assistant.")) {
    if (event.sender !== panel.webContents) throw new Error("请在主面板操作。");
    if (!assistantStore) throw new Error(assistantError);
    if (name === "assistant.get") return assistantStore.snapshot();
    if (name === "assistant.create") return assistantStore.create(value || {});
    if (name === "assistant.change")
      return assistantStore.change(value?.id, value?.status);
    if (name === "assistant.clear") return assistantStore.clearFinished();
    if (name === "assistant.todo-add")
      return assistantStore.addTodo(value || {});
    if (name === "assistant.todo-toggle")
      return assistantStore.changeTodo(value, false);
    if (name === "assistant.todo-delete")
      return assistantStore.changeTodo(value, true);
    if (name === "assistant.work-save")
      return assistantStore.saveSession(value || {});
    if (name === "assistant.work-delete")
      return assistantStore.deleteSession(value);
    if (name === "assistant.work-restore") {
      const item = assistantStore.getSession(value);
      return draftToChat(
        `保存的工作现场：${item.title}\n保存时间：${new Date(item.createdAt).toLocaleString()}\n\n上次问题：${item.question}\n下一步：${item.nextStep}\n\n背景：${item.context}`,
        "继续上次工作",
      );
    }
    if (name === "assistant.scene-preview")
      return buildScene(awareness.snapshot());
    throw new Error("不支持的生活助手操作。");
  }
  if (name.startsWith("context.") || name.startsWith("shortcuts.")) {
    if (event.sender !== panel.webContents) throw new Error("请在主面板操作。");
    if (name === "context.get")
      return { draft: contextDraft.get(), error: contextError };
    if (name === "context.clear") {
      contextDraft.clear(value);
      contextError = "";
      return;
    }
    if (name === "context.app") {
      if (!awareness.snapshot().enabled) throw new Error("请先开启应用感知。");
      return draftToChat(appContentReader.context(value), "应用窗口内容");
    }
    if (name === "context.page") {
      const state = awareness.snapshot();
      if (!state.enabled || !state.browserEnabled)
        throw new Error("请先开启应用和浏览器感知。");
      const browserId = typeof value === "string" ? value : value?.bundleId;
      if (!state.apps.some((a) => a.bundleId === browserId))
        throw new Error("请先打开支持的浏览器。");
      const candidates = state.apps.filter((a) => a.bundleId === browserId);
      const pid =
        typeof value === "object"
          ? value?.pid
          : candidates.length === 1
            ? candidates[0].pid
            : undefined;
      if (!Number.isInteger(pid) || !candidates.some((a) => a.pid === pid))
        throw new Error("请从列表选择具体浏览器实例，或刷新应用列表。");
      let target = { pid };
      if (typeof value === "object" && value && value.windowId !== undefined) {
        const observed = state.tabs.find(
          (t) =>
            t.bundleId === browserId &&
            t.pid === pid &&
            t.windowId === value.windowId &&
            t.tabId === value.tabId,
        );
        if (!observed) throw new Error("标签页列表已变化，请重新刷新并选择。");
        target = {
          pid,
          windowId: observed.windowId,
          tabId: observed.tabId,
          title: observed.title,
          activate: value.activate === true,
        };
      }
      if (pageReading) throw new Error("正在读取网页，请稍后再试。");
      pageReading = true;
      const generation = awareness.generation;
      try {
        const text = await readPage(browserId, target);
        const current = awareness.snapshot();
        if (
          !current.enabled ||
          !current.browserEnabled ||
          generation !== awareness.generation
        )
          throw new Error("读取已取消：浏览器感知已关闭。");
        return draftToChat(text, "网页正文");
      } finally {
        pageReading = false;
      }
    }
    if (name === "context.scene")
      return draftToChat(buildScene(awareness.snapshot()), "应用与标签页场景");
    if (name === "context.permission-status")
      return selectionRead(selectionExecutable(), true);
    if (name === "context.permissions")
      return shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    if (name === "shortcuts.get") return shortcutStatus;
    if (name === "shortcuts.save") {
      const result = registerShortcuts(value);
      preferences.shortcuts = {
        enabled: result.enabled,
        chat: result.chat,
        selection: result.selection,
      };
      save();
      return result;
    }
    throw new Error("不支持的操作。");
  }
  if (name.startsWith("awareness.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在应用感知面板操作。");
    if (name === "awareness.get") return awareness.snapshot();
    if (name === "awareness.content-permissions")
      return appContentReader.permissions();
    if (name === "awareness.request-permission")
      return appContentReader.request(value);
    if (name === "awareness.content") {
      const state = awareness.snapshot();
      if (!state.enabled) throw new Error("请先开启应用感知。");
      const target = state.apps.find(
        (a) => a.pid === value?.pid && a.bundleId === value?.bundleId,
      );
      if (!target) throw new Error("应用已退出或列表已变化，请刷新。");
      return appContentReader.read(target, value.method);
    }

    if (name === "awareness.configure") {
      const result = awareness.configure(value || {});
      if (!result.enabled) appContentReader.clear();
      preferences.awareness = {
        enabled: result.enabled,
        browserEnabled: result.browserEnabled,
      };
      save();
      return result;
    }
    if (name === "awareness.refresh") return awareness.refresh();
    if (name === "awareness.browser") return awareness.browser(value);
    if (name === "awareness.permissions")
      return shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      );
    throw new Error("不支持的感知操作。");
  }
  if (name.startsWith("handoff.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在主面板处理 AI 交接。");
    if (!handoff) throw new Error("AI 交接尚未就绪。");
    if (name === "handoff.get") return handoffState();
    if (name === "handoff.configure") {
      if (typeof value?.enabled !== "boolean") throw new Error("设置无效。");
      preferences.handoff = { enabled: value.enabled };
      save();
      await (value.enabled ? handoff.start() : handoff.stop());
      return handoffState();
    }
    if (name === "handoff.preview")
      return handoff.preview(value?.requestId, value?.projectId);
    if (name === "handoff.decide") {
      await handoff.decide(value?.requestId, value || {});
      return handoffState();
    }
    if (name === "handoff.copy") {
      const text = handoffSetup().snippets[value];
      if (typeof text !== "string") throw new Error("没有这个接入方式。");
      clipboard.writeText(text);
      return { ok: true };
    }
    if (name === "handoff.revoke") {
      handoff.revoke(value);
      return handoffState();
    }
    throw new Error("不支持的交接操作。");
  }
  if (name === "open-panel") return showPanel();
  if (name === "open-chat") return showChat();
  if (name === "pet.interact" && typeof value === "string")
    return interactPet(value);
  if (name === "pet.menu" && event.sender === pet.webContents) {
    pet.setIgnoreMouseEvents(false);
    petMenu().popup({
      window: pet,
      callback: () => {
        if (!pet.isDestroyed())
          pet.setIgnoreMouseEvents(true, { forward: true });
      },
    });
    return;
  }
  if (name === "hide-pet") {
    preferences.hidden = true;
    pet.hide();
    save();
    refreshTray();
    return;
  }
  if (name === "quiet" && typeof value === "boolean") {
    preferences.quiet = value;
    save();
    refreshTray();
    broadcast({ type: "preferences", data: preferencesPublic() });
    return;
  }
  if (name === "theme") {
    if (event.sender !== panel.webContents)
      throw new Error("请在设置里更换主题。");
    if (!THEMES.includes(value)) throw new Error("不支持的主题。");
    preferences.theme = value;
    save();
    applyAppearance();
    broadcast({ type: "preferences", data: preferencesPublic() });
    return;
  }
  if (
    name === "hit" &&
    event.sender === pet.webContents &&
    typeof value === "boolean"
  ) {
    if (!drag) pet.setIgnoreMouseEvents(!value, { forward: true });
    return;
  }
  if (name === "drag-start" && event.sender === pet.webContents) {
    drag = {
      cursor: screen.getCursorScreenPoint(),
      position: pet.getPosition(),
    };
    pet.setIgnoreMouseEvents(false);
    return;
  }
  if (name === "drag-move" && drag && event.sender === pet.webContents) {
    const c = screen.getCursorScreenPoint();
    const p = clampPosition(
      drag.position[0] + c.x - drag.cursor.x,
      drag.position[1] + c.y - drag.cursor.y,
    );
    pet.setPosition(p.x, p.y);
    return;
  }
  if (name === "drag-end" && event.sender === pet.webContents) {
    drag = null;
    const [x, y] = pet.getPosition();
    preferences.position = { x, y };
    save();
    return;
  }
  if (name === "reconnect") {
    ensureIdle();
    await connect();
    return;
  }
  if (name === "choose-config") {
    ensureIdle();
    if (process.env.OTTER_DESKTOP_CONFIG)
      throw new Error("请先移除 OTTER_DESKTOP_CONFIG 环境变量。");
    const picked = await dialog.showOpenDialog(panel, {
      title: "选择 Otter 配置",
      properties: ["openFile"],
      filters: [{ name: "TOML 配置", extensions: ["toml"] }],
    });
    if (picked.canceled) return;
    const config = picked.filePaths[0];
    const folder = await dialog.showOpenDialog(panel, {
      title: "选择配置对应的 Otter 项目根目录",
      defaultPath: path.dirname(config),
      properties: ["openDirectory"],
    });
    if (folder.canceled) return;
    preferences.selection = { config, root: folder.filePaths[0] };
    save();
    await connect();
    broadcast({ type: "preferences", data: preferencesPublic() });
    return;
  }
  if (name === "use-demo") {
    ensureIdle();
    if (process.env.OTTER_DESKTOP_CONFIG)
      throw new Error("请先移除 OTTER_DESKTOP_CONFIG 环境变量。");
    delete preferences.selection;
    save();
    await connect();
    if (backend && !backend.closed) {
      await backend.call("models.reset");
      currentHealth = await backend.call("health.get");
      broadcast({
        type: "connection",
        data: { status: "online", health: currentHealth },
      });
    }
    broadcast({ type: "preferences", data: preferencesPublic() });
    return;
  }
  if (name === "open-link" && typeof value === "string") {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("不支持的链接。");
    await shell.openExternal(url.href);
    return;
  }
  throw new Error("不支持的操作。");
}
if (process.env.OTTER_DESKTOP_USER_DATA)
  app.setPath("userData", path.resolve(process.env.OTTER_DESKTOP_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showPanel);
  app.whenReady().then(async () => {
    try {
      preferences = JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
      if (!preferences || typeof preferences !== "object") preferences = {};
    } catch {
      preferences = {};
    }
    evolution.restore(preferences.evolution);
    nativeTheme.themeSource = themeSource(preferences.theme);
    extensions = new Extensions({
      load: () => preferences.extensions,
      save: (value) => {
        preferences.extensions = value;
        save();
      },
    });
    extensions.on("change", (data) => {
      if (panel && !panel.isDestroyed())
        panel.webContents.send("otter:event", {
          type: "extensions.changed",
          data,
        });
    });
    toolHost.addSource(extensions.source());
    extensions.init();
    skills = new SkillLibrary({
      dir: path.join(app.getPath("userData"), "skills"),
      // Skills shipped with the app (add-mcp-server…), outside the asar.
      builtin: app.isPackaged
        ? path.join(process.resourcesPath, "skills")
        : path.join(__dirname, "../skills"),
      // Other tools' skill folders, read where they are. OTTER_SKILLS_HOME
      // points the tests at a fixture instead of the real home folder.
      external: [
        ["agents", "共享", ".agents/skills"],
        ["claude", "Claude Code", ".claude/skills"],
        ["codex", "Codex", ".codex/skills"],
      ].map(([id, label, folder]) => ({
        id,
        label,
        dir: path.join(
          process.env.OTTER_SKILLS_HOME || app.getPath("home"),
          folder,
        ),
      })),
      load: () => preferences.skills,
      save: (value) => {
        preferences.skills = value;
        save();
      },
      onChange: (data) => {
        if (panel && !panel.isDestroyed())
          panel.webContents.send("otter:event", {
            type: "skills.changed",
            data,
          });
      },
    });
    try {
      skills.scan();
    } catch {}
    toolHost.addSource(skills.source());
    ssh = new SshManager({
      load: () => preferences.ssh,
      save: (value) => {
        preferences.ssh = value;
        save();
      },
      dir: path.join(app.getPath("userData"), "ssh"),
      // The tests point these at fixtures and keep Terminal closed.
      home: process.env.OTTER_SSH_HOME || app.getPath("home"),
      keychain: new SshKeychain({
        keychain: process.env.OTTER_SSH_KEYCHAIN || null,
      }),
      ...(process.env.OTTER_TEST_NO_TERMINAL
        ? { openFile: async () => {} }
        : {}),
      onChange: (data) => {
        if (panel && !panel.isDestroyed())
          panel.webContents.send("otter:event", { type: "ssh.changed", data });
      },
    });
    void ssh.warm().catch(() => {});
    toolHost.addSource(sshTools);
    appContentReader = new AppContentReader(
      app.isPackaged
        ? path.join(process.resourcesPath, "native/otter-app-content")
        : path.join(root, "desktop/build/native/otter-app-content"),
    );
    petState = new PetState(preferences.petState);
    ambient = new Ambient(preferences.ambient);
    const area = screen.getPrimaryDisplay().workArea;
    const position = preferences.position || {
      x: area.x + area.width - 270,
      y: area.y + area.height - 290,
    };
    pet = new BrowserWindow({
      ...windowOptions(),
      width: 220,
      height: 250,
      ...clampPosition(position.x, position.y),
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
    });
    panel = new BrowserWindow({
      ...windowOptions(),
      width: 1060,
      height: 740,
      minWidth: 760,
      minHeight: 560,
      title: "Otter · 桌面伙伴",
      backgroundColor: windowColor(
        preferences.theme,
        nativeTheme.shouldUseDarkColors,
      ),
      show: false,
      titleBarStyle: "hiddenInset",
    });
    protect(pet);
    protect(panel);
    panel.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        panel.hide();
      }
    });
    panel.on("ready-to-show", () => {
      if (!preferences.started) {
        panel.show();
        preferences.started = true;
        save();
      }
    });
    pet.on("ready-to-show", () => {
      if (!preferences.hidden) pet.showInactive();
    });
    pet.setIgnoreMouseEvents(true, { forward: true });
    pet.loadFile(page, { query: { view: "pet", theme: themeQuery() } });
    panel.loadFile(page, { query: { view: "panel", theme: themeQuery() } });
    nativeTheme.on("updated", applyAppearance);
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    );
    tray = new Tray(icon);
    tray.setTitle("🦦");
    tray.setToolTip("Otter · 桌面伙伴");
    refreshTray();
    awareness = new Awareness({
      emit: (state) => {
        const id = state.front?.bundleId || "";
        if (id !== lastAmbientApp) {
          lastAmbientApp = id;
          if (
            [
              "com.microsoft.VSCode",
              "com.apple.dt.Xcode",
              "com.apple.Terminal",
              "com.googlecode.iterm2",
              "com.jetbrains.intellij",
            ].includes(id)
          )
            ambientEvent("coding");
        }
        if (panel && !panel.isDestroyed())
          panel.webContents.send("otter:event", {
            type: "awareness.changed",
            data: state,
          });
      },
    });
    awareness.configure({
      enabled: preferences.awareness?.enabled === true,
      browserEnabled: preferences.awareness?.browserEnabled === true,
    });
    screen.on("display-removed", reposition);
    screen.on("display-metrics-changed", reposition);
    app.on("activate", showPanel);
    try {
      assistantStore = new AssistantStore(
        path.join(app.getPath("userData"), "assistant.json"),
        {
          emit: (state) => {
            body.observe({ type: "assistant.changed", data: state });
            if (panel && !panel.isDestroyed())
              panel.webContents.send("otter:event", {
                type: "assistant.changed",
                data: state,
              });
          },
          notify: (value) => {
            if (value.title === "专注结束") ambientEvent("focus");
            if (Notification.isSupported()) {
              const notification = new Notification({
                title: value.title,
                body: value.body,
              });
              notification.on("click", () => {
                showPanel();
                panel.webContents.send("otter:event", {
                  type: "navigation",
                  data: { view: "assistant" },
                });
              });
              notification.show();
            }
            broadcast({
              type: "pet.notice",
              data: { message: value.title + "：" + value.body },
            });
          },
        },
      );
      assistantStore.start();
      taskAssistant = new TaskAssistant({
        store: assistantStore,
        gate: actionGate,
        timezone: () => currentHealth?.timezone || "Asia/Shanghai",
        interpret: (params) => backend.call("tasks.plan", params),
        record: (params) => backend.call("tasks.record", params),
        checkProject: (params) => backend.call("projects.check", params),
        scope: (session_id) => backend.call("projects.scope", { session_id }),
        settings: chatSettings,
        ssh: {
          clean: (server) => ssh.clean(server),
          describe: (server, password) => ssh.describe(server, password),
          save: (server, password) => ssh.saveHost(server, { password }),
        },
        // Created before this; read through so a reconnect keeps working.
        extensions: {
          preview: (text) => extensions.preview(text),
          add: (text) => extensions.add(text),
        },
        projectAction: async (plan, request) => {
          if (plan.kind === "project_capture")
            return {
              kind: "capture",
              projectId: plan.project_id,
              sessionId: request.sessionId,
            };
          if (plan.kind === "project_resume") {
            const result = await backend.call("projects.resume", {
              project_id: plan.project_id,
              session_id: request.sessionId,
            });
            return { kind: "result", message: result.message };
          }
          return backend.call("projects.resolve", plan);
        },
      });
      powerMonitor.on("resume", () => assistantStore.tick());
    } catch {
      assistantError =
        "生活助手数据无法读取，请保留 assistant.json 并检查备份；其他功能仍可使用。";
    }
    speechPlayer = new SpeechPlayer({
      emit: (state) => broadcast({ type: "voice.activity", data: state }),
    });
    handoff = new HandoffBroker({
      socketPath: path.join(app.getPath("userData"), "handoff.sock"),
      logPath: path.join(app.getPath("userData"), "handoff.json"),
      call: (method, params) =>
        !backend || switching
          ? Promise.reject(new Error("Otter 后台未连接，请稍后重试。"))
          : backend.call(method, params),
      todos: (projectId) =>
        (assistantStore?.snapshot().todos || []).filter(
          (t) => t.projectId === projectId,
        ),
      timezone: () => currentHealth?.timezone,
    });
    handoff.on("changed", () => {
      evolution.observe({
        type: "handoff.changed",
        data: {
          pending: (handoff.snapshot().pending || []).map((request) => ({
            id: request.id,
          })),
        },
      });
      if (panel && !panel.isDestroyed())
        panel.webContents.send("otter:event", {
          type: "handoff.changed",
          data: handoffState(),
        });
    });
    handoff.on("inbox", () => {
      if (panel && !panel.isDestroyed())
        panel.webContents.send("otter:event", { type: "handoff.inbox" });
    });
    handoff.on("request", (r) =>
      handoffNotify(
        "Otter · AI 交接请求",
        `${r.client.name} 想读取${r.project ? `「${r.project}」的` : ""}项目进度，请在“AI 交接”里决定。`,
      ),
    );
    handoff.on("proposal", (p) =>
      handoffNotify(
        "Otter · 收到交接进度",
        `${p.client.name} 交来一份${p.project ? `「${p.project}」的` : ""}进度，等你检查。`,
      ),
    );
    if (preferences.handoff?.enabled) void handoff.start();
    const audioTemp = path.join(app.getPath("userData"), "audio-temp");
    if (fs.existsSync(audioTemp))
      for (const name of fs.readdirSync(audioTemp)) {
        if (/^[0-9a-f]{32}\.webm$/.test(name))
          fs.rmSync(path.join(audioTemp, name), { force: true });
      }
    registerShortcuts(preferences.shortcuts);
    seedBody();
    body.configure({ enabled: preferences.body?.enabled === true });
    await connect();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearTimeout(petEffectTimer);
    awareness?.close();
    appContentReader?.clear();
    void handoff?.stop();
    assistantStore?.close();
    speechPlayer?.stop();
    body.stop();
    evolution.close();
    extensions?.stopAll();
    globalShortcut.unregisterAll();
    (backend ? backend.stop() : Promise.resolve()).finally(() => app.quit());
  });
}
