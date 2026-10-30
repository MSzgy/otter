// A small MCP client. Local servers are commands spoken to over stdio, the
// kind people add to Claude Desktop with "command" and "args"; remote ones are
// URLs, over streamable HTTP or the older SSE transport. It does the
// initialize handshake, lists tools (following pagination and list_changed)
// and calls them. Nothing here decides permission; tool-host.cjs does.
const { spawn, execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");

const PROTOCOL = "2025-06-18";
// The largest single answer (a line, a JSON body or an event stream) read.
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

function cleanHeaders(name, headers) {
  if (
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    Object.keys(headers).length > 20 ||
    Object.entries(headers).some(
      ([k, v]) =>
        !/^[A-Za-z0-9-]{1,64}$/.test(k) ||
        /^(host|content-length|content-type|accept|connection|mcp-session-id|mcp-protocol-version)$/i.test(
          k,
        ) ||
        typeof v !== "string" ||
        v.length > 4000 ||
        /[\r\n]/.test(v),
    )
  )
    throw new Error(`“${name}”的 headers 要是“名字: 文字”的对象。`);
  return headers;
}

// A remote server: https anywhere, plain http only on this Mac.
function cleanRemote(name, value) {
  const raw = value.url ?? value.serverUrl;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`“${name}”的 url 不是有效网址。`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error(`“${name}”要用 https 网址（本机服务可以用 http）。`);
  if (url.username || url.password)
    throw new Error(`“${name}”的网址里不要写账号密码，请放在 headers 里。`);
  const type = String(value.type || value.transport || "").toLowerCase();
  if (
    type &&
    !["http", "streamable-http", "streamablehttp", "sse"].includes(type)
  )
    throw new Error(`“${name}”的 type 只能是 http 或 sse。`);
  const transport =
    type === "sse" || (!type && /\/sse\/?$/.test(url.pathname))
      ? "sse"
      : "http";
  return {
    name: name.trim(),
    url: url.href,
    transport,
    headers: cleanHeaders(name, value.headers || {}),
  };
}

// Validates one server entry as written in a Claude Desktop style config.
function cleanServer(name, value) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40)
    throw new Error("服务名称要在 1–40 个字以内。");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`“${name}”的配置不是对象。`);
  if (value.url || value.serverUrl) return cleanRemote(name, value);
  if (["http", "sse", "streamable-http"].includes(value.type))
    throw new Error(`“${name}”是网络服务，要写上 url。`);
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
  else if (
    ["command", "url", "serverUrl"].some((k) => typeof value[k] === "string")
  ) {
    const { name, ...rest } = value;
    value = { [name || "mcp"]: rest };
  }
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

// Server-sent events from a fetch body: calls back with each event's name
// and data. Stops at the end of the body or when the reader is cancelled.
async function readEvents(body, onEvent, limit = MAX_LINE) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    event = "",
    data = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > limit) throw new Error("服务返回的数据过大。");
    let end;
    while ((end = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer[end] === "\r" ? 2 : 1));
      if (!line) {
        if (data.length) onEvent(event || "message", data.join("\n"));
        event = "";
        data = [];
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length) onEvent(event || "message", data.join("\n"));
}
function httpError(status) {
  if (status === 401 || status === 403)
    return new Error(
      `服务要求登录或令牌（HTTP ${status}），可以在 headers 里加上 Authorization。`,
    );
  if (status === 404)
    return new Error("服务地址不存在，或者会话已失效（HTTP 404）。");
  return new Error(`服务返回 HTTP ${status}。`);
}
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// A local command, one JSON message per line on stdin and stdout.
class StdioConnection {
  constructor({ command, args, env, cwd }) {
    Object.assign(this, { command, args, env, cwd });
    this.buffer = "";
    this.stderr = "";
  }
  async open({ onMessage, onClose }) {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, PATH: await shellPath(), ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_LINE) {
        this.buffer = "";
        onClose("服务返回的数据过大。");
        return;
      }
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        // Servers sometimes log to stdout; skip what is not JSON.
        const message = line && parse(line);
        if (message) onMessage(message);
      }
    });
    child.stderr.setEncoding("utf8");
    // Kept short and local: it only explains a failure to start.
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    child.on("error", (error) =>
      onClose(
        error.code === "ENOENT"
          ? `找不到命令“${this.command}”。`
          : `无法启动：${error.message}`,
      ),
    );
    child.on("exit", (code) => {
      if (this.child !== child) return;
      const last = this.stderr.trim().split("\n").pop() || "";
      onClose(
        `服务已退出（${code ?? "被停止"}）${last ? "：" + last.slice(0, 200) : "。"}`,
      );
    });
    child.stdin.on("error", () => {});
  }
  async send(message) {
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }
  close() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
  }
}

// Streamable HTTP: each message is a POST; the answer comes back as JSON or
// as a short event stream. Keeps the server's session id and the protocol
// version it chose.
class HttpConnection {
  constructor({ url, headers }) {
    Object.assign(this, { url, headers });
    this.controllers = new Set();
  }
  async open({ onMessage }) {
    this.onMessage = onMessage;
  }
  async send(message) {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
          ...(this.protocol ? { "MCP-Protocol-Version": this.protocol } : {}),
        },
        body: JSON.stringify(message),
      });
      if (message.method === "initialize")
        this.session = response.headers.get("mcp-session-id") || undefined;
      if (response.status === 202 || response.status === 204) return;
      if (!response.ok) throw httpError(response.status);
      const type = response.headers.get("content-type") || "";
      const deliver = (value) => {
        if (value?.result?.protocolVersion && message.method === "initialize")
          this.protocol = value.result.protocolVersion;
        if (value) this.onMessage(value);
      };
      if (type.includes("text/event-stream"))
        await readEvents(response.body, (_event, data) => deliver(parse(data)));
      else {
        const text = await response.text();
        if (text.length > MAX_LINE) throw new Error("服务返回的数据过大。");
        const value = parse(text);
        for (const item of Array.isArray(value) ? value : [value])
          deliver(item);
      }
    } finally {
      this.controllers.delete(controller);
    }
  }
  close() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (this.session)
      fetch(this.url, {
        method: "DELETE",
        headers: { ...this.headers, "Mcp-Session-Id": this.session },
      }).catch(() => {});
    this.session = undefined;
  }
}

// The older SSE transport: one long GET carries every answer; the server
// names, in its first event, where to POST. That place must be on the same
// origin as the configured URL.
class SseConnection {
  constructor({ url, headers, timeout }) {
    Object.assign(this, { url, headers, timeout });
  }
  open({ onMessage, onClose }) {
    this.controller = new AbortController();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("服务没有告诉 Otter 往哪里发消息。")),
        this.timeout,
      );
      fetch(this.url, {
        headers: { ...this.headers, Accept: "text/event-stream" },
        signal: this.controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw httpError(response.status);
          await readEvents(response.body, (event, data) => {
            if (event === "endpoint") {
              const endpoint = new URL(data.trim(), this.url);
              if (endpoint.origin !== new URL(this.url).origin)
                throw new Error("服务要求把消息发到别的网站，已拒绝。");
              this.endpoint = endpoint.href;
              clearTimeout(timer);
              resolve();
            } else {
              const message = parse(data);
              if (message) onMessage(message);
            }
          });
          if (this.controller) onClose("和服务的连接断开了。");
        })
        .catch((error) => {
          clearTimeout(timer);
          if (!this.controller) return;
          reject(error);
          onClose(error.message);
        });
    });
  }
  async send(message) {
    if (!this.endpoint) throw new Error("服务没有在运行。");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw httpError(response.status);
  }
  close() {
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
  }
}

class McpServer extends EventEmitter {
  constructor({
    name,
    command,
    args = [],
    env = {},
    cwd,
    url,
    transport = "http",
    headers = {},
    timeout = 30000,
  }) {
    super();
    Object.assign(this, {
      name,
      command,
      args,
      env,
      cwd,
      url,
      transport,
      headers,
      timeout,
    });
    this.status = "off";
    this.message = "";
    this.tools = [];
    this.pending = new Map();
    this.sequence = 0;
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
  connect() {
    if (!this.url) return new StdioConnection(this);
    return this.transport === "sse"
      ? new SseConnection(this)
      : new HttpConnection(this);
  }
  async start() {
    if (this.connection) return;
    this.set("starting");
    try {
      const connection = this.connect();
      this.connection = connection;
      await connection.open({
        onMessage: (message) => this.dispatch(message),
        onClose: (reason) => {
          if (this.connection === connection) this.fail(reason);
        },
      });
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
    const connection = this.connection;
    this.connection = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.tools = [];
    connection?.close();
    if (!["off", "stopping"].includes(this.status)) this.set("error", message);
  }
  stop() {
    this.status = "stopping";
    this.fail("已停止。");
    this.set("off");
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
  dispatch(message) {
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
      this.connection
        ?.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Otter 不支持这个请求。" },
        })
        .catch(() => {});
    }
  }
  notify(method, params) {
    this.connection
      ?.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })
      .catch(() => {});
  }
  request(method, params) {
    const connection = this.connection;
    if (!connection) return Promise.reject(new Error("服务没有在运行。"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`“${this.name}”没有在规定时间内回应。`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      connection.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
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
