const { spawn } = require("node:child_process");
class SpeechPlayer {
  constructor({ launch = spawn, emit = () => {} } = {}) {
    this.launch = launch;
    this.emit = emit;
    this.child = null;
  }
  speak(text) {
    if (typeof text !== "string" || !text.trim() || text.length > 8000)
      throw new Error("朗读文字应为 1–8000 字符。");
    this.stop();
    const child = this.launch("/usr/bin/say", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    this.child = child;
    child.stderr?.on("data", () => {});
    child.stdin.on("error", () => {});
    this.emit({ speaking: true });
    const finish = (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.emit({
        speaking: false,
        error: error ? "系统朗读失败，请检查声音输出。" : "",
      });
    };
    child.on("error", () => finish(true));
    child.on("exit", (code) => finish(code !== 0));
    child.stdin.end(text);
    return { ok: true };
  }
  stop() {
    if (this.child) {
      const old = this.child;
      this.child = null;
      old.kill("SIGTERM");
    }
    this.emit({ speaking: false });
  }
}
module.exports = { SpeechPlayer };
