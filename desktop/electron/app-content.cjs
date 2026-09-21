const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
class AppContentReader {
  constructor(executable) {
    this.executable = executable;
    this.child = null;
    this.last = null;
    this.epoch = 0;
    this.permissionPromise = null;
  }
  clear() {
    this.epoch++;
    this.last = null;
    this.permissionPromise = null;
    if (this.child) this.child.kill("SIGTERM");
    this.child = null;
  }
  permissions() {
    if (this.permissionPromise) return this.permissionPromise;
    const promise = this.run(["--permissions"], 5000);
    this.permissionPromise = promise;
    const finish = () => {
      if (this.permissionPromise === promise) this.permissionPromise = null;
    };
    promise.then(finish, finish);
    return promise;
  }
  async request(permission) {
    if (!["accessibility", "screen"].includes(permission))
      throw new Error("权限类型无效。");
    if (this.permissionPromise) await this.permissionPromise.catch(() => {});
    return this.run(["--request-" + permission], 65000);
  }
  run(args, timeout) {
    if (this.child)
      return Promise.reject(new Error("正在读取，请等待当前操作完成。"));
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.executable,
        args,
        { timeout, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (this.child === child) this.child = null;
          if (error) {
            reject(
              new Error(
                "窗口内容读取超时或失败；应用可能没有响应。请重新打开目标窗口后重试。",
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("窗口读取工具返回格式无效。"));
          }
        },
      );
      this.child = child;
    });
  }
  async read(app, method) {
    if (!["ax", "ocr"].includes(method)) throw new Error("读取方式无效。");
    const epoch = this.epoch;
    if (this.permissionPromise) await this.permissionPromise.catch(() => {});
    if (epoch !== this.epoch) throw new Error("读取已取消。");
    if (this.child)
      throw new Error("正在读取窗口，请等待或关闭应用感知以取消。");
    const raw = await this.run(
      [String(app.pid), app.bundleId, method],
      method === "ocr" ? 30000 : 12000,
    );
    if (epoch !== this.epoch) throw new Error("读取已取消。");
    const result = {
      id: randomUUID(),
      app: { ...app },
      method,
      status: raw.status,
      permission: raw.permission || null,
      truncated: raw.truncated === true,
      observedAt: Date.now(),
      windows: [],
    };
    let remaining = 20000;
    for (const window of (Array.isArray(raw.windows) ? raw.windows : []).slice(
      0,
      8,
    )) {
      const text = String(window.text || "").slice(0, remaining);
      remaining -= text.length;
      result.windows.push({
        id: String(window.id),
        title: String(window.title || "窗口").slice(0, 300),
        text,
        protectedFieldsSkipped: window.protectedFieldsSkipped === true,
      });
      if (remaining <= 0) break;
    }
    if (result.status === "ready" && !result.windows.some((w) => w.text.trim()))
      result.status = "empty";
    this.last = result;
    return structuredClone(result);
  }
  context(id) {
    const result = this.last;
    if (!result || result.id !== id || result.status !== "ready")
      throw new Error("内容已变化或尚未读取，请重新读取目标应用。");
    return `来源应用：${result.app.name}\n读取方式：${result.method === "ocr" ? "本机窗口 OCR（可能存在识别错误）" : "macOS 辅助功能窗口文字"}\n读取时间：${new Date(result.observedAt).toLocaleString()}\n${result.truncated ? "内容达到读取上限，以下是部分内容。" : ""}\n\n${result.windows.map((w) => `【${w.title}】\n${w.text}`).join("\n\n")}`.slice(
      0,
      24000,
    );
  }
}
module.exports = { AppContentReader };
