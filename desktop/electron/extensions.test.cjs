const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Extensions } = require("./extensions.cjs");

class FakeServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.status = "off";
    this.tools = [];
    this.calls = [];
  }
  async start() {
    this.status = "ready";
    this.tools = [
      { name: "look", title: "看笔记", annotations: { readOnlyHint: true } },
      {
        name: "add_note",
        description: "记一条",
        inputSchema: { type: "object" },
      },
    ];
    this.emit("change");
  }
  stop() {
    this.status = "off";
  }
  snapshot() {
    return {
      status: this.status,
      message: "",
      tools: this.tools.map((t) => ({
        name: t.name,
        title: t.title || t.name,
      })),
    };
  }
  async call(name, args) {
    this.calls.push([name, args]);
    return "ok";
  }
}

function setup(initial = {}) {
  let stored = initial;
  const servers = [];
  const ext = new Extensions({
    load: () => stored,
    save: (value) => (stored = value),
    createServer: (config) => {
      const server = new FakeServer(config);
      servers.push(server);
      return server;
    },
  });
  return { ext, servers, stored: () => stored };
}
const config = JSON.stringify({
  mcpServers: { notes: { command: "node", args: ["s.js"], env: { KEY: "k" } } },
});

test("preview changes nothing; add saves, starts and offers the tools", async () => {
  const { ext, servers, stored } = setup();
  assert.deepEqual(ext.preview(config), [
    { name: "notes", command: "node", args: ["s.js"], envKeys: ["KEY"] },
  ]);
  assert.equal(servers.length, 0);
  assert.deepEqual(stored(), {});
  ext.add(config);
  await new Promise((r) => setImmediate(r));
  assert.equal(stored().servers[0].env.KEY, "k", "env is kept for the command");
  assert.equal(ext.snapshot().servers[0].status, "ready");
  assert.deepEqual(ext.snapshot().servers[0].envKeys, ["KEY"]);
  const tools = ext.source().list();
  assert.deepEqual(
    tools.map((t) => [t.name, t.label, t.origin, t.readOnly, t.autoApprove]),
    [
      ["mcp__notes__look", "看笔记", "notes", true, false],
      ["mcp__notes__add_note", "add_note", "notes", false, false],
    ],
  );
  assert.equal(tools[1].description, "[notes] 记一条");
  assert.equal(await tools[1].run({ text: "a" }), "ok");
  assert.deepEqual(servers[0].calls, [["add_note", { text: "a" }]]);
  assert.throws(() => ext.add(config), /已经有叫“notes”/);
});

test("不用再问, disable, remove and the master switch", async () => {
  const { ext, servers, stored } = setup();
  ext.add(config);
  await new Promise((r) => setImmediate(r));
  const id = stored().servers[0].id;
  ext.setAllow(id, "add_note", true);
  assert.equal(ext.source().list()[1].autoApprove, true);
  assert.equal(ext.snapshot().servers[0].tools[1].autoApprove, true);
  ext.setEnabled(id, false);
  assert.equal(servers[0].status, "off");
  assert.deepEqual(ext.source().list(), [], "A stopped server offers nothing");
  ext.setEnabled(id, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(ext.source().list().length, 2);
  assert.equal(ext.enabled, true);
  ext.setTools(false);
  assert.equal(ext.enabled, false);
  ext.remove(id);
  assert.deepEqual(stored().servers, []);
  assert.deepEqual(stored().allow, [], "Its 不用再问 marks go with it");
  assert.throws(() => ext.remove(id), /没有这个服务/);
});

test("enabled servers start on init; disabled ones do not", () => {
  const { ext, servers } = setup({
    servers: [
      { id: "a", name: "a", command: "x", args: [], env: {}, enabled: true },
      { id: "b", name: "b", command: "y", args: [], env: {}, enabled: false },
    ],
  });
  ext.init();
  assert.deepEqual(
    servers.map((s) => s.config.name),
    ["a"],
  );
});

test("remote servers are shown by address and header names, never values", async () => {
  const { ext, servers, stored } = setup();
  const remote = JSON.stringify({
    mcpServers: {
      cloud: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer secret-token" },
      },
    },
  });
  const preview = ext.preview(remote);
  assert.deepEqual(preview, [
    {
      name: "cloud",
      url: "https://mcp.example.com/mcp",
      transport: "http",
      headerKeys: ["Authorization"],
    },
  ]);
  ext.add(remote);
  await new Promise((r) => setImmediate(r));
  assert.equal(servers[0].config.url, "https://mcp.example.com/mcp");
  assert.equal(servers[0].config.headers.Authorization, "Bearer secret-token");
  assert.equal(
    stored().servers[0].headers.Authorization,
    "Bearer secret-token",
  );
  assert(!JSON.stringify(ext.snapshot()).includes("secret-token"));
});

const { TaskAssistant } = require("./task-assistant.cjs");

test("adding from chat: a card with what will run, added only after 确认", async () => {
  const { ext, servers } = setup();
  let plan = {
    kind: "mcp_add",
    config: {
      mcpServers: {
        notes: { command: "node", args: ["s.js"], env: { KEY: "k" } },
      },
    },
  };
  const records = [];
  const tasks = new TaskAssistant({
    store: { snapshot: () => ({ reminders: [], todos: [] }) },
    gate: { cancel() {} },
    extensions: { preview: (t) => ext.preview(t), add: (t) => ext.add(t) },
    interpret: async () => plan,
    record: async (r) => records.push(r),
  });
  const ask = () =>
    tasks.plan({ text: "加 MCP", sessionId: "s", requestId: "r" });
  const card = await ask();
  assert.equal(card.title, "确认添加 MCP 服务");
  assert.match(card.detail, /notes：运行 node s\.js（环境变量：KEY）/);
  assert.match(card.detail, /只添加你信任的服务/);
  assert.equal(servers.length, 0, "Nothing starts before 确认");
  const done = await tasks.confirm({ id: card.id, sessionId: "s" });
  assert.equal(done.ok, true);
  assert.match(done.message, /已添加 MCP 服务：notes/);
  assert.equal(servers.length, 1);
  const again = await ask();
  assert.equal(again.kind, "result");
  assert.match(again.message, /没有添加：已经有叫“notes”/);
  plan = {
    kind: "mcp_add",
    config: { web: { url: "http://example.com/mcp" } },
  };
  assert.match((await ask()).message, /没有添加：.*要用 https/);
  plan = {
    kind: "mcp_add",
    config: { web: { url: "https://example.com/mcp" } },
  };
  assert.match(
    (await ask()).detail,
    /web：连接 https:\/\/example\.com\/mcp\n\n你允许的工具调用/,
  );
  plan = {
    kind: "mcp_add",
    config: {
      vault: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer tok-123" },
      },
    },
  };
  const tokenCard = await tasks.plan({
    text: '加 {"vault":{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer tok-123"}}}',
    sessionId: "s",
    requestId: "r",
  });
  await tasks.confirm({ id: tokenCard.id, sessionId: "s" });
  assert(!records.at(-1).text.includes("tok-123"), "The chat keeps no token");
  assert.match(records.at(-1).text, /"Authorization":"••••"/);
});
