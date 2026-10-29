// A small MCP client for local (stdio) servers, the kind people add to Claude
// Desktop with "command" and "args". It starts the command, does the
// initialize handshake, lists tools (following pagination and list_changed)
// and calls them. Nothing here decides permission; tool-host.cjs does.
const { spawn, execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");

const PROTOCOL = "2025-06-18";
const MAX_LINE = 4 * 1024 * 1024;

// Apps opened from Finder get a bare PATH, so `npx` or `uvx` would not be
// found. Ask the login shell once for the PATH a terminal would have.
let loginPath;
function shellPath() {
  if (loginPath) return loginPath;
  loginPath = new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(
      shell,
      ["-l", "-c", 'printf "__OTTER_PATH__%s" "$PATH"'],
      { timeout: 5000 },
      (error, stdout = "") => {
        const found = String(stdout).split("__OTTER_PATH__")[1];
        const parts = [
          ...(found && !error ? found.split(":") : []),
          ...(process.env.PATH || "").split(":"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ].filter(Boolean);
        resolve([...new Set(parts)].join(":"));
      },
    );
  });
  return loginPath;
}

// Validates one server entry as written in a Claude Desktop style config.
function cleanServer(name, value) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40)
    throw new Error("服务名称要在 1–40 个字以内。");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`“${name}”的配置不是对象。`);
  if (value.url || value.type === "http" || value.type === "sse")
    throw new Error(`“${name}”是网络服务；暂时只支持本机命令（stdio）。`);
  const { command, args = [], env = {} } = value;
  if (typeof command !== "string" || !command.trim() || command.length > 500)
    throw new Error(`“${name}”缺少要运行的 command。`);
  if (
    !Array.isArray(args) ||
    args.length > 50 ||
    args.some((a) => typeof a !== "string" || a.length > 2000)
  )
    throw new Error(`“${name}”的 args 要是字符串列表。`);
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.keys(env).length > 30 ||
    Object.entries(env).some(
      ([k, v]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ||
        typeof v !== "string" ||
        v.length > 4000,
    )
  )
    throw new Error(`“${name}”的 env 要是“名字: 文字”的对象。`);
  return { name: name.trim(), command: command.trim(), args, env };
}

// Accepts {"mcpServers": {...}}, a bare {"name": {...}} map, or one server
// object with a "name". Returns the server entries; changes nothing.
function parseConfig(text) {
  if (typeof text !== "string" || text.length > 20000)
    throw new Error("配置要是 20000 字以内的 JSON。");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("配置不是有效的 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("配置要是一个 JSON 对象。");
  if (value.mcpServers) value = value.mcpServers;
  else if (typeof value.command === "string")
    value = { [value.name || "mcp"]: value };
  const entries = Object.entries(value);
  if (!entries.length) throw new Error("配置里没有 MCP 服务。");
  if (entries.length > 10) throw new Error("一次最多添加 10 个服务。");
  return entries.map(([name, server]) => cleanServer(name, server));
}

// Tool names the model sees: mcp__<server>__<tool>, at most 64 characters.
function toolName(server, tool) {
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  // Server names without Latin letters or digits (say, 我的笔记) become a
  // short hash; a tool name that would change or overflow gets one too.
  const clean = server.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 24);
  const prefix = `mcp__${/[A-Za-z0-9]/.test(clean) ? clean : "s" + hash(server).slice(0, 6)}__`;
  const name = prefix + tool;
  if (name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name)) return name;
  const safe = tool
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 64 - prefix.length - 13);
  return `${prefix}${safe}_${hash(server + "\n" + tool).slice(0, 12)}`;
}

// Text the model can read from a tools/call result.
function resultText(result) {
  const parts = (result?.content || []).map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "resource") return part.resource?.text || "[资源]";
    if (part.type === "image") return "[图片]";
    if (part.type === "audio") return "[音频]";
    return `[${part.type || "内容"}]`;
  });
  if (result?.structuredContent && !parts.length)
    parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n").trim() || "（工具没有返回内容）";
}

class McpServer extends EventEmitter {
  constructor({ name, command, args = [], env = {}, cwd, timeout = 30000 }) {
    super();
    Object.assign(this, { name, command, args, env, cwd, timeout });
    this.status = "off";
    this.message = "";
    this.tools = [];
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = "";
    this.stderr = "";
  }
  snapshot() {
    return {
      status: this.status,
      message: this.message,
      tools: this.tools.map((t) => ({
        name: t.name,
        title: t.title || t.annotations?.title || t.name,
        description: t.description || "",
        readOnly: t.annotations?.readOnlyHint === true,
      })),
    };
  }
  set(status, message = "") {
    this.status = status;
    this.message = message;
    this.emit("change", this.snapshot());
  }
  async start() {
    if (this.child) return;
    this.set("starting");
    try {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, PATH: await shellPath(), ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.consume(chunk));
      child.stderr.setEncoding("utf8");
      // Kept short and local: it only explains a failure to start.
      child.stderr.on("data", (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-2000);
      });
      child.on("error", (error) =>
        this.fail(
          error.code === "ENOENT"
            ? `找不到命令“${this.command}”。`
            : `无法启动：${error.message}`,
        ),
      );
      child.on("exit", (code) => {
        if (this.child !== child) return;
        const last = this.stderr.trim().split("\n").pop() || "";
        this.fail(
          `服务已退出（${code ?? "被停止"}）${last ? "：" + last.slice(0, 200) : "。"}`,
        );
      });
      child.stdin.on("error", () => {});
      await this.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "otter", version: "0.12.0" },
      });
      this.notify("notifications/initialized");
      await this.refresh();
      this.set("ready");
    } catch (error) {
      this.fail(error.message);
      throw error;
    }
  }
  fail(message) {
    const child = this.child;
    this.child = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.tools = [];
    if (child && child.exitCode === null) child.kill();
    if (this.status !== "off") this.set("error", message);
  }
  stop() {
    const child = this.child;
    this.child = null;
    this.fail("已停止。");
    this.set("off");
    if (child && child.exitCode === null) child.kill();
  }
  async refresh() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    this.tools = tools.filter(
      (t) => t && typeof t.name === "string" && t.name.length <= 128,
    );
    this.emit("change", this.snapshot());
  }
  async call(name, args) {
    if (this.status !== "ready") throw new Error(`“${this.name}”没有在运行。`);
    const result = await this.request("tools/call", {
      name,
      arguments: args || {},
    });
    if (result?.isError) throw new Error(resultText(result));
    return resultText(result);
  }
  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) {
      this.buffer = "";
      this.fail("服务返回的数据过大。");
      return;
    }
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Servers sometimes log to stdout; skip what is not JSON.
      }
      if (message.id != null && this.pending.has(message.id)) {
        const p = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error)
          p.reject(new Error(message.error.message || "服务返回错误。"));
        else p.resolve(message.result);
      } else if (message.method === "notifications/tools/list_changed") {
        this.refresh().catch(() => {});
      } else if (message.id != null && message.method) {
        // Requests from the server (sampling, roots…) are not offered.
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Otter 不支持这个请求。" },
        });
      }
    }
  }
  write(message) {
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }
  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }
  request(method, params) {
    if (!this.child) return Promise.reject(new Error("服务没有在运行。"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`“${this.name}”没有在规定时间内回应。`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
}

module.exports = {
  McpServer,
  parseConfig,
  cleanServer,
  toolName,
  resultText,
  shellPath,
};
