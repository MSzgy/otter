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
