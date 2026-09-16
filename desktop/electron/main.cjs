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
} = require("electron");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { Backend } = require("./bridge.cjs");
const { Awareness } = require("./awareness.cjs");
let awareness;
const { PetState, ACTIONS } = require("./pet-state.cjs");
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
  activeView = "reports";
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
function broadcast(event) {
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
function preferencesPublic() {
  return {
    quiet: !!preferences.quiet,
    hidden: !!preferences.hidden,
    config: selection().config,
    envConfig: !!process.env.OTTER_DESKTOP_CONFIG,
  };
}
async function connect() {
  if (switching) return;
  switching = true;
  try {
    if (backend) {
      const old = backend;
      backend = null;
      await old.stop();
    }
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
      if (event.type === "chat.changed") {
        chatState = event.data;
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
      lastJob = event.data;
      broadcast(event);
      if (
        event.data.status === "finished" &&
        !preferences.quiet &&
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
  win.webContents.session.setPermissionRequestHandler((_w, _p, cb) =>
    cb(false),
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
    JSON.stringify(params).length > 16000
  )
    throw new Error("参数无效。");
  if (!backend || switching) throw new Error("后台尚未就绪。");
  if (
    (method.startsWith("models.") || method.startsWith("chat.")) &&
    event.sender !== panel.webContents
  )
    throw new Error("请在设置面板中配置模型。");
  const result = await backend.call(method, params);
  if (method === "chat.delete" && chatState?.session_id === params.session_id)
    chatState = null;
  if (["models.save", "models.reset"].includes(method)) {
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
  if (name === "snapshot")
    return {
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
  if (name.startsWith("awareness.")) {
    if (event.sender !== panel.webContents)
      throw new Error("请在应用感知面板操作。");
    if (name === "awareness.get") return awareness.snapshot();
    if (name === "awareness.configure") {
      const result = awareness.configure(value || {});
      preferences.awareness = {
        enabled: result.enabled,
        browserEnabled: result.browserEnabled,
      };
      save();
      return result;
    }
    if (name === "awareness.refresh") return awareness.refresh();
    if (name === "awareness.browser" && typeof value === "string")
      return awareness.browser(value);
    if (name === "awareness.permissions")
      return shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      );
    throw new Error("不支持的感知操作。");
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
});
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
    petState = new PetState(preferences.petState);
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
      backgroundColor: "#f7f8f6",
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
    pet.loadFile(page, { query: { view: "pet" } });
    panel.loadFile(page, { query: { view: "panel" } });
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    );
    tray = new Tray(icon);
    tray.setTitle("🦦");
    tray.setToolTip("Otter · 桌面伙伴");
    refreshTray();
    awareness = new Awareness({
      emit: (state) => {
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
    await connect();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearTimeout(petEffectTimer);
    awareness?.close();
    (backend ? backend.stop() : Promise.resolve()).finally(() => app.quit());
  });
}
