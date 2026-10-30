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
    ['{"x":{"url":"http://example.com/mcp"}}', /要用 https/],
    ['{"x":{"url":"https://u:p@example.com/mcp"}}', /不要写账号密码/],
    ['{"x":{"url":"not a url"}}', /不是有效网址/],
    ['{"x":{"url":"https://a.com","type":"ws"}}', /只能是 http 或 sse/],
    ['{"x":{"url":"https://a.com","headers":{"Host":"b"}}}', /headers/],
    ['{"x":{"type":"http"}}', /要写上 url/],
    ['{"x":{"args":[]}}', /缺少要运行的 command/],
    ['{"x":{"command":"a","args":"b"}}', /字符串列表/],
    ['{"x":{"command":"a","env":{"bad key":"v"}}}', /env/],
  ])
    assert.throws(() => parseConfig(text), message);
});

test("remote servers: https or this Mac's http, transport from type or /sse", () => {
  const [a, b, c] = parseConfig(
    JSON.stringify({
      mcpServers: {
        cloud: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer t" },
        },
        old: { url: "https://mcp.example.com/sse" },
        here: { serverUrl: "http://127.0.0.1:9000/x", type: "streamable-http" },
      },
    }),
  );
  assert.deepEqual(a, {
    name: "cloud",
    url: "https://mcp.example.com/mcp",
    transport: "http",
    headers: { Authorization: "Bearer t" },
  });
  assert.equal(b.transport, "sse");
  assert.equal(c.transport, "http");
  assert.equal(
    parseConfig('{"name":"one","url":"https://a.com/mcp"}')[0].name,
    "one",
  );
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

const { startFakeHttpMcp } = require("../scripts/fake-mcp-http.cjs");

for (const transport of ["http", "sse"])
  test(`a remote ${transport} server: handshake, tools, calls and stop`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-mcp-http-"));
    const notes = path.join(dir, "notes.txt");
    const fake = await startFakeHttpMcp({
      transport,
      token: "s3cret",
      notesFile: notes,
    });
    t.after(async () => {
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const server = new McpServer({
      name: "remote",
      url: fake.url,
      transport,
      headers: { Authorization: "Bearer s3cret" },
      timeout: 5000,
    });
    await server.start();
    assert.equal(server.status, "ready");
    assert.deepEqual(
      server.snapshot().tools.map((x) => x.name),
      ["look", "add_note"],
    );
    assert.equal(
      await server.call("add_note", { text: "远程" }),
      "记下了：远程",
    );
    assert.equal(fs.readFileSync(notes, "utf8"), "远程\n");
    if (transport === "http") {
      const later = fake.seen.filter((m) => m.method !== "initialize");
      assert(
        later.every((m) => m.session),
        "Session id on every later request",
      );
      assert(
        later.every((m) => m.protocol === "2025-06-18"),
        "Protocol version on every later request",
      );
    }
    server.stop();
    assert.equal(server.status, "off");
    if (transport === "http") {
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fake.seen.at(-1).method, "DELETE", "The session is ended");
    }
  });

test("a remote server that wants a token says so", async (t) => {
  const fake = await startFakeHttpMcp({ token: "s3cret" });
  t.after(() => fake.close());
  const server = new McpServer({
    name: "remote",
    url: fake.url,
    timeout: 3000,
  });
  await assert.rejects(server.start(), /要求登录或令牌（HTTP 401）/);
  assert.equal(server.status, "error");
});
