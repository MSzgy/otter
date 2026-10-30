// 工具与扩展: whether the chat may call tools at all, and the MCP servers the
// user added. Keeps their config (preferences.extensions), runs the enabled
// ones and offers their tools to the tool host. A tool the user marked
// 不用再问 runs without a card; every other MCP tool asks each time.
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { McpServer, parseConfig, toolName } = require("./mcp-client.cjs");

// How a server is shown: what it runs or where it connects, and the names
// (never the values) of its env variables or headers.
function describe(s) {
  return s.url
    ? {
        name: s.name,
        url: s.url,
        transport: s.transport,
        headerKeys: Object.keys(s.headers || {}),
      }
    : {
        name: s.name,
        command: s.command,
        args: s.args,
        envKeys: Object.keys(s.env || {}),
      };
}

// What a confirmation card says about servers about to be added: what runs
// or where it connects, names (never values) of env and headers, and why
// to be careful.
function summary(servers, note = "") {
  const line = (s) =>
    s.url
      ? `${s.name}：连接 ${s.url}${s.headerKeys?.length ? `（请求头：${s.headerKeys.join("、")}）` : ""}`
      : `${s.name}：运行 ${[s.command, ...s.args].join(" ")}${s.envKeys?.length ? `（环境变量：${s.envKeys.join("、")}）` : ""}`;
  const warnings = [
    servers.some((s) => !s.url) &&
      "这会在你的 Mac 上运行上面的命令，只添加你信任的服务。",
    servers.some((s) => s.url) && "你允许的工具调用会把参数发给这个网络服务。",
    note,
  ].filter(Boolean);
  return `${servers.map(line).join("\n")}\n\n${warnings.join("\n")}`;
}

class Extensions extends EventEmitter {
  constructor({
    load,
    save,
    createServer = (config) => new McpServer(config),
  }) {
    super();
    Object.assign(this, { load, save, createServer });
    this.running = new Map();
  }
  config() {
    const value = this.load() || {};
    return {
      tools: value.tools !== false,
      servers: Array.isArray(value.servers) ? value.servers : [],
      allow: Array.isArray(value.allow) ? value.allow : [],
    };
  }
  write(next) {
    this.save(next);
    this.emit("change", this.snapshot());
  }
  get enabled() {
    return this.config().tools;
  }
  init() {
    for (const server of this.config().servers)
      if (server.enabled !== false) this.start(server);
  }
  start(server) {
    if (this.running.has(server.id)) return;
    const instance = this.createServer({
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      transport: server.transport,
      headers: server.headers,
    });
    instance.on("change", () => this.emit("change", this.snapshot()));
    this.running.set(server.id, instance);
    instance.start().catch(() => {});
  }
  stop(id) {
    const instance = this.running.get(id);
    this.running.delete(id);
    instance?.stop();
  }
  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }
  snapshot() {
    const { tools, servers, allow } = this.config();
    return {
      tools,
      servers: servers.map((s) => {
        const live = this.running.get(s.id)?.snapshot() || {
          status: "off",
          message: "",
          tools: [],
        };
        return {
          id: s.id,
          ...describe(s),
          enabled: s.enabled !== false,
          status: live.status,
          message: live.message,
          tools: live.tools.map((t) => ({
            ...t,
            autoApprove: allow.includes(`${s.id}/${t.name}`),
          })),
        };
      }),
    };
  }
  // What a pasted config would add, without changing anything.
  preview(text) {
    const names = this.config().servers.map((s) => s.name);
    return parseConfig(text).map((entry) => {
      if (names.includes(entry.name))
        throw new Error(`已经有叫“${entry.name}”的服务了。`);
      return describe(entry);
    });
  }
  add(text) {
    const config = this.config();
    const entries = parseConfig(text);
    for (const entry of entries)
      if (config.servers.some((s) => s.name === entry.name))
        throw new Error(`已经有叫“${entry.name}”的服务了。`);
    const added = entries.map((e) => ({
      id: randomUUID(),
      ...e,
      enabled: true,
    }));
    this.write({ ...config, servers: [...config.servers, ...added] });
    for (const server of added) this.start(server);
    return this.snapshot();
  }
  find(id) {
    const config = this.config();
    const server = config.servers.find((s) => s.id === id);
    if (!server) throw new Error("没有这个服务。");
    return { config, server };
  }
  setEnabled(id, enabled) {
    const { config, server } = this.find(id);
    if (typeof enabled !== "boolean") throw new Error("设置无效。");
    this.write({
      ...config,
      servers: config.servers.map((s) => (s.id === id ? { ...s, enabled } : s)),
    });
    if (enabled) this.start({ ...server, enabled });
    else this.stop(id);
    return this.snapshot();
  }
  remove(id) {
    const { config } = this.find(id);
    this.stop(id);
    this.write({
      ...config,
      servers: config.servers.filter((s) => s.id !== id),
      allow: config.allow.filter((key) => !key.startsWith(id + "/")),
    });
    return this.snapshot();
  }
  setAllow(id, tool, allow) {
    const { config } = this.find(id);
    if (typeof tool !== "string" || typeof allow !== "boolean")
      throw new Error("设置无效。");
    const key = `${id}/${tool}`;
    const rest = config.allow.filter((k) => k !== key);
    this.write({ ...config, allow: allow ? [...rest, key] : rest });
    return this.snapshot();
  }
  setTools(enabled) {
    if (typeof enabled !== "boolean") throw new Error("设置无效。");
    this.write({ ...this.config(), tools: enabled });
    return this.snapshot();
  }
  // A tool-host source: the tools of every server that is running.
  source() {
    return {
      list: () => {
        const { servers, allow } = this.config();
        const tools = [];
        for (const server of servers) {
          const instance = this.running.get(server.id);
          if (!instance || instance.status !== "ready") continue;
          for (const tool of instance.tools)
            tools.push({
              name: toolName(server.name, tool.name),
              label: tool.title || tool.annotations?.title || tool.name,
              origin: server.name,
              description:
                `[${server.name}] ${tool.description || tool.name}`.slice(
                  0,
                  1000,
                ),
              parameters:
                tool.inputSchema && typeof tool.inputSchema === "object"
                  ? tool.inputSchema
                  : { type: "object", properties: {} },
              readOnly: tool.annotations?.readOnlyHint === true,
              autoApprove: allow.includes(`${server.id}/${tool.name}`),
              run: (args) => instance.call(tool.name, args),
            });
        }
        return tools;
      },
    };
  }
}
module.exports = { Extensions, summary };
