const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const BROWSERS = Object.freeze({
  "com.apple.Safari": "Safari",
  "com.google.Chrome": "Google Chrome",
  "com.microsoft.edgemac": "Microsoft Edge",
  "com.brave.Browser": "Brave",
});
// Read the packaged source and use -e: osascript cannot open files inside app.asar directly.
function nativeRead(kind, id, signal) {
  const script = fs.readFileSync(
    path.join(__dirname, "native", kind + ".js"),
    "utf8",
  );
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, ...(id ? [id] : [])],
      {
        timeout: kind === "browser" ? 12000 : 5000,
        maxBuffer: 512 * 1024,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const denied =
            String(stderr).includes("-1743") ||
            /not authorized|not permitted/i.test(String(stderr));
          const result = new Error(
            denied
              ? "浏览器访问未获允许。请在系统设置 → 隐私与安全性 → 自动化中授权后重试。"
              : "无法读取，请确认应用仍在运行后重试。",
          );
          result.code = denied ? "DENIED" : "READ_FAILED";
          reject(result);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("系统返回的数据无法识别。"));
        }
      },
    );
  });
}
function cleanApp(value) {
  if (
    !value ||
    typeof value.name !== "string" ||
    typeof value.bundleId !== "string" ||
    !Number.isInteger(value.pid)
  )
    return null;
  return {
    name: value.name.slice(0, 160),
    bundleId: value.bundleId.slice(0, 250),
    pid: value.pid,
  };
}
function cleanTab(result, id) {
  if (result?.status !== "ready") return null;
  let url = typeof result.url === "string" ? result.url : "";
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) url = "";
    else {
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      url = parsed.href;
    }
  } catch {
    url = "";
  }
  return {
    bundleId: id,
    name: BROWSERS[id],
    title: String(result.title || "无标题").slice(0, 500),
    url: url.slice(0, 2048),
    observedAt: Date.now(),
  };
}
class Awareness {
  constructor({
    read = nativeRead,
    emit = () => {},
    platform = process.platform,
  } = {}) {
    this.read = read;
    this.emit = emit;
    this.platform = platform;
    this.timer = null;
    this.controller = null;
    this.generation = 0;
    this.running = false;
    this.blocked = new Set();
    this.state = {
      enabled: false,
      browserEnabled: false,
      status: "off",
      apps: [],
      front: null,
      browser: null,
      browserStatus: "off",
      updatedAt: null,
      message: "",
    };
  }
  snapshot() {
    return structuredClone({ ...this.state, supportedBrowsers: BROWSERS });
  }
  publish() {
    this.emit(this.snapshot());
  }
  configure(settings) {
    if (
      typeof settings.enabled !== "boolean" ||
      typeof settings.browserEnabled !== "boolean"
    )
      throw new Error("感知开关参数无效。");
    this.generation++;
    this.controller?.abort();
    clearInterval(this.timer);
    this.timer = null;
    this.state.enabled = settings.enabled;
    this.state.browserEnabled = settings.browserEnabled && settings.enabled;
    if (!settings.enabled) {
      this.state = {
        ...this.state,
        status: "off",
        apps: [],
        front: null,
        browser: null,
        browserStatus: "off",
        updatedAt: null,
        message: "",
      };
      this.publish();
      return this.snapshot();
    }
    this.state.status = this.platform === "darwin" ? "ready" : "unsupported";
    this.state.message = this.platform === "darwin" ? "" : "当前仅支持 macOS。";
    if (!this.state.browserEnabled) {
      this.state.browser = null;
      this.state.browserStatus = "off";
    }
    this.publish();
    if (this.platform === "darwin") {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), 4000);
      this.timer.unref?.();
    }
    return this.snapshot();
  }
  async refresh() {
    if (!this.state.enabled || this.platform !== "darwin" || this.running)
      return this.snapshot();
    this.running = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.read("apps", null, controller.signal);
      if (generation !== this.generation) return this.snapshot();
      this.state.apps = (Array.isArray(result.apps) ? result.apps : [])
        .map(cleanApp)
        .filter(Boolean)
        .slice(0, 200)
        .sort((a, b) => a.name.localeCompare(b.name));
      this.state.front = cleanApp(result.front);
      this.state.updatedAt = Date.now();
      this.state.status = "ready";
      if (!["denied", "error"].includes(this.state.browserStatus))
        this.state.message = "";
      this.publish();
      const id = this.state.front?.bundleId;
      if (
        this.state.browserEnabled &&
        Object.hasOwn(BROWSERS, id) &&
        !this.blocked.has(id)
      ) {
        await this.captureBrowser(id, generation, controller.signal);
      }
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) {
        this.state.status = "error";
        this.state.message = "应用感知暂时不可用，请重试。";
        this.publish();
      }
    } finally {
      this.running = false;
      if (this.controller === controller) this.controller = null;
    }
    return this.snapshot();
  }
  async captureBrowser(id, generation, signal) {
    try {
      const result = await this.read("browser", id, signal);
      if (generation !== this.generation || !this.state.browserEnabled) return;
      this.state.browser = cleanTab(result, id);
      this.state.browserStatus = result.status === "ready" ? "ready" : "no_tab";
      this.state.message = "";
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      this.blocked.add(id);
      this.state.browser = null;
      this.state.browserStatus = error.code === "DENIED" ? "denied" : "error";
      this.state.message =
        error.code === "DENIED"
          ? "浏览器访问未获允许。可在系统设置 → 隐私与安全性 → 自动化中授权，然后点击重试。"
          : "浏览器读取失败，已暂停自动重试。请确认浏览器存在普通窗口，再手动重试。";
    }
    this.publish();
  }
  async browser(id) {
    if (!this.state.enabled || !this.state.browserEnabled)
      throw new Error("请先开启应用感知和浏览器标签页感知。");
    if (!Object.hasOwn(BROWSERS, id)) throw new Error("暂不支持这个浏览器。");
    if (!this.state.apps.some((app) => app.bundleId === id))
      throw new Error("浏览器尚未运行，请打开浏览器并刷新应用列表。");
    if (this.running) throw new Error("正在更新感知信息，请稍后重试。");
    this.running = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.blocked.delete(id);
    try {
      await this.captureBrowser(id, generation, controller.signal);
    } finally {
      this.running = false;
      if (this.controller === controller) this.controller = null;
    }
    return this.snapshot();
  }
  close() {
    this.configure({ enabled: false, browserEnabled: false });
  }
}
module.exports = { Awareness, BROWSERS, nativeRead, cleanTab };
