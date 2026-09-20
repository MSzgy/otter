const { randomUUID } = require("node:crypto");
class ActionGate {
  constructor({ resolveApp, execute, now = Date.now }) {
    this.resolveApp = resolveApp;
    this.execute = execute;
    this.now = now;
    this.pending = new Map();
  }
  async prepare(params) {
    let action;
    if (params.kind === "open_url") {
      let url;
      try {
        url = new URL(params.target);
      } catch {
        throw new Error("请输入完整的网址。");
      }
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("仅支持不含账号密码的 HTTP(S) 链接。");
      action = {
        kind: "open_url",
        target: url.href,
        label: "打开链接",
        description: url.href,
      };
    } else if (params.kind === "open_app") {
      if (
        typeof params.target !== "string" ||
        params.target.length > 250 ||
        !/^\w[\w.-]+\.[\w.-]+$/.test(params.target)
      )
        throw new Error("请输入有效的应用标识，例如 com.apple.calculator。");
      const found = await this.resolveApp(params.target);
      if (!found) throw new Error("没有找到这个应用。");
      action = {
        kind: "open_app",
        target: params.target,
        label: "打开应用",
        description: found.name || params.target,
      };
    } else throw new Error("不支持这个操作。");
    for (const [key, value] of this.pending)
      if (value.expiresAt < this.now()) this.pending.delete(key);
    if (this.pending.size >= 20)
      throw new Error("待确认操作过多，请取消后重试。");
    const proposal = {
      ...action,
      id: randomUUID(),
      expiresAt: this.now() + 60000,
    };
    this.pending.set(proposal.id, proposal);
    return { ...proposal };
  }
  cancel(id) {
    this.pending.delete(id);
  }
  async confirm(id) {
    const proposal = this.pending.get(id);
    this.pending.delete(id);
    if (!proposal || proposal.expiresAt < this.now())
      throw new Error("操作确认已过期，请重新预览。");
    await this.execute(proposal);
    return {
      ok: true,
      message:
        proposal.kind === "open_url"
          ? "已交给默认浏览器打开链接。"
          : "已请求 macOS 打开应用。",
    };
  }
}
module.exports = { ActionGate };
