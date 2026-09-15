const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
class Backend extends EventEmitter {
  constructor(command, args, options = {}) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.closed = false;
    this.process = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.consume(chunk));
    this.process.stderr.on("data", () => {}); // Never forward private plugin logs to renderers.
    this.process.on("error", () =>
      this.fail("无法启动后台，请检查 Python 环境或重新安装应用。"),
    );
    this.process.on("exit", () =>
      this.fail("后台已停止，请在设置中重新连接。"),
    );
    this.process.stdin.on("error", () => this.fail("后台连接中断。"));
  }
  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.fail("后台数据过大。");
      this.process.kill();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.jsonrpc !== "2.0") continue;
        if (message.id != null) {
          const p = this.pending.get(message.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(message.id);
            message.error
              ? p.reject(new Error(message.error.message))
              : p.resolve(message.result);
          }
        } else if (message.method === "job.changed")
          this.emit("event", { type: message.method, data: message.params });
      } catch {
        /* A bad frame does not remove pending request timeouts. */
      }
    }
  }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("后台未连接。"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("后台响应超时。"));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  fail(message) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.emit("offline", message);
  }
  async stop() {
    this.fail("后台正在关闭。");
    if (
      this.process.exitCode != null ||
      this.process.signalCode != null ||
      !this.process.pid
    )
      return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => this.process.kill("SIGKILL"), 3000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.process.stdin.end();
    });
  }
}
module.exports = { Backend };
