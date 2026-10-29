const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  McpServer,
  parseConfig,
  toolName,
  resultText,
} = require("./mcp-client.cjs");

const fixture = path.resolve(__dirname, "../scripts/fake-mcp-server.cjs");

test("configs in Claude Desktop form, a bare map or one server all parse", () => {
  const one = { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "t" } };
  assert.deepEqual(
    parseConfig(JSON.stringify({ mcpServers: { files: one } })),
    [{ name: "files", ...one }],
  );
  assert.equal(parseConfig(JSON.stringify({ a: one, b: one })).length, 2);
  assert.equal(
    parseConfig(JSON.stringify({ name: "solo", command: "uvx" }))[0].name,
    "solo",
  );
  for (const [text, message] of [
    ["not json", /有效的 JSON/],
    ["[]", /JSON 对象/],
    ['{"mcpServers":{}}', /没有 MCP 服务/],
    ['{"x":{"url":"https://example.com/mcp"}}', /只支持本机命令/],
    ['{"x":{"args":[]}}', /缺少要运行的 command/],
    ['{"x":{"command":"a","args":"b"}}', /字符串列表/],
    ['{"x":{"command":"a","env":{"bad key":"v"}}}', /env/],
  ])
    assert.throws(() => parseConfig(text), message);
});

test("tool names are unique, safe and within 64 characters", () => {
  assert.equal(toolName("files", "read_file"), "mcp__files__read_file");
  assert.match(toolName("我的 笔记", "add"), /^mcp__s[0-9a-f]{6}__add$/);
  assert.notEqual(toolName("我的 笔记", "add"), toolName("另一个", "add"));
  const long = toolName("server", "x".repeat(80));
  assert(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long));
  assert.notEqual(
    toolName("server", "x".repeat(80) + "a"),
    toolName("server", "x".repeat(80) + "b"),
  );
  assert.equal(
    resultText({ content: [{ type: "text", text: "a" }, { type: "image" }] }),
    "a\n[图片]",
  );
});

test("a real stdio server: handshake, paged tools, calls, errors and stop", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-mcp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notes = path.join(dir, "notes.txt");
  const server = new McpServer({
    name: "fake",
    command: process.execPath,
    args: [fixture],
    env: { NOTES_FILE: notes },
    timeout: 5000,
  });
  const states = [];
  server.on("change", (s) => states.push(s.status));
  await server.start();
  t.after(() => server.stop());
  assert.equal(server.status, "ready");
  assert.deepEqual(
    server.snapshot().tools.map((x) => [x.name, x.title, x.readOnly]),
    [
      ["look", "看笔记", true],
      ["add_note", "记一条笔记", false],
    ],
  );
  assert.equal(
    await server.call("add_note", { text: "买牛奶" }),
    "记下了：买牛奶",
  );
  assert.equal(fs.readFileSync(notes, "utf8"), "买牛奶\n");
  assert.equal(await server.call("look", {}), "买牛奶");
  await assert.rejects(server.call("missing", {}), /没有这个工具/);
  server.stop();
  assert.equal(server.status, "off");
  await assert.rejects(server.call("look", {}), /没有在运行/);
  assert(states.includes("starting") && states.includes("ready"));
});

test("a command that does not exist fails with a plain message", async () => {
  const server = new McpServer({
    name: "ghost",
    command: "otter-no-such-command-xyz",
    timeout: 2000,
  });
  await assert.rejects(server.start(), /找不到命令/);
  assert.equal(server.status, "error");
  assert.match(server.message, /找不到命令/);
});
