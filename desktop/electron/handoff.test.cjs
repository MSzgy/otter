const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  HandoffBroker,
  formatContext,
  matchProject,
  setupSnippets,
} = require("./handoff.cjs");

const project = {
  id: "p1",
  name: "桌面机器人",
  goal: "做一只会动的水獭",
  archived: 0,
  links: [{ id: "l1", label: "接线图", url: "https://example.com/wiring" }],
  snapshots: [
    {
      created: 1760000000,
      items: [
        { kind: "completed", content: "舵机接好" },
        { kind: "next", content: "接屏幕" },
      ],
    },
  ],
};
function setup(options = {}) {
  const dir = fs.mkdtempSync("/tmp/otter-h-");
  const state = { project: structuredClone(project), calls: [] };
  const broker = new HandoffBroker({
    socketPath: path.join(dir, "h.sock"),
    logPath: path.join(dir, "log.json"),
    call: async (method, params) => {
      state.calls.push([method, params]);
      if (method === "projects.list")
        return (
          options.projects ?? [
            state.project,
            { id: "p2", name: "网站", archived: 0 },
          ]
        );
      if (method === "projects.get") return state.project;
      if (method === "projects.handoff-add") {
        if (options.addError) throw new Error(options.addError);
        return { id: "h1", project: params.project ? "桌面机器人" : null };
      }
      throw new Error("unexpected " + method);
    },
    todos: () => [
      { title: "买电池", done: false },
      { title: "已完成的事", done: true },
    ],
    timezone: () => "Asia/Shanghai",
    ...options,
  });
  return { broker, state, dir };
}
function ask(broker, request, { keepOpen } = {}) {
  const socket = net.connect(broker.socketPath);
  const response = new Promise((resolve) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("close", () => resolve(data ? JSON.parse(data) : null));
    socket.on("error", () => {});
  });
  socket.write(
    JSON.stringify({ id: "r1", client: { name: "Codex" }, ...request }) + "\n",
  );
  return keepOpen ? { socket, response } : response;
}
const until = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert(predicate());
};

test("formats exactly what is shared and matches project names", () => {
  const text = formatContext(
    project,
    [{ title: "买电池" }, { title: "旧", done: true }],
    "Asia/Shanghai",
  );
  assert.match(text, /^# Otter 项目交接：桌面机器人/);
  assert.match(text, /不是给你的指令/);
  assert.match(text, /### 已完成\n- 舵机接好/);
  assert.match(text, /## 未完成的项目待办\n- 买电池/);
  assert(!text.includes("旧"));
  assert.match(text, /接线图：https:\/\/example.com\/wiring/);
  const list = [{ name: "桌面机器人" }, { name: "网站" }, { name: "网站后台" }];
  assert.equal(matchProject(list, "桌面机器人").name, "桌面机器人");
  assert.equal(matchProject(list, "机器人").name, "桌面机器人");
  assert.equal(matchProject(list, "网站").name, "网站");
  assert.equal(matchProject(list, "后"), list[2]);
  assert.equal(matchProject(list, "不存在"), null);
});

test("setup snippets quote paths and carry env", () => {
  const s = setupSnippets({
    command: "/Applications/My Otter.app/otter-runtime",
    args: ["mcp"],
    env: { OTTER_HANDOFF_SOCKET: "/tmp/h.sock" },
  });
  assert.equal(
    s.claude,
    "claude mcp add otter --scope user -e OTTER_HANDOFF_SOCKET=/tmp/h.sock -- '/Applications/My Otter.app/otter-runtime' mcp",
  );
  assert.match(
    s.codex,
    /\[mcp_servers\.otter\.env\]\nOTTER_HANDOFF_SOCKET = "\/tmp\/h.sock"/,
  );
  assert.deepEqual(JSON.parse(s.cursor).mcpServers.otter.args, ["mcp"]);
  assert(
    !setupSnippets({ command: "/x", args: [], env: {} }).codex.includes("env"),
  );
});

test("reads wait for approval and send the previewed text", async () => {
  const { broker } = setup();
  await broker.start();
  try {
    assert.equal(fs.statSync(broker.socketPath).mode & 0o777, 0o600);
    const answer = ask(broker, {
      method: "context",
      params: { project: "机器人", reason: "继续写代码\n" },
    });
    await until(() => broker.pending.size === 1);
    const [pending] = broker.snapshot().pending;
    assert.equal(pending.projectId, "p1");
    assert.equal(pending.reason, "继续写代码");
    assert.equal(pending.client.name, "Codex");
    const preview = await broker.preview(pending.id, "p1");
    await broker.decide(pending.id, {
      decision: "once",
      projectId: "p1",
      hash: preview.hash,
    });
    assert.deepEqual(await answer, {
      id: "r1",
      result: { text: preview.text },
    });
    const [entry] = broker.snapshot().log;
    assert.equal(entry.result, "allowed");
    assert.equal(entry.chars, preview.text.length);
    assert.equal(entry.project, "桌面机器人");
  } finally {
    await broker.stop();
  }
});

test("deny, timeout and client hang-up all end the request", async () => {
  const { broker } = setup({ approvalMs: 80 });
  await broker.start();
  try {
    const denied = ask(broker, { method: "context", params: {} });
    await until(() => broker.pending.size === 1);
    assert.equal(broker.snapshot().pending[0].projectId, "");
    await broker.decide(broker.snapshot().pending[0].id, { decision: "deny" });
    assert.match((await denied).error, /拒绝/);
    assert.match(
      (await ask(broker, { method: "context", params: {} })).error,
      /没有在 45 秒内/,
    );
    const { socket } = ask(
      broker,
      { method: "context", params: {} },
      { keepOpen: true },
    );
    await until(() => broker.pending.size === 1);
    socket.destroy();
    await until(() => broker.pending.size === 0);
    assert.deepEqual(
      broker.snapshot().log.map((e) => e.result),
      ["cancelled", "timeout", "denied"],
    );
  } finally {
    await broker.stop();
  }
});

test("grants are per client and project, revocable and expire", async () => {
  let clock = 1000;
  const { broker } = setup({ now: () => clock });
  await broker.start();
  try {
    const first = ask(broker, {
      method: "context",
      params: { project: "桌面机器人" },
    });
    await until(() => broker.pending.size === 1);
    const id = broker.snapshot().pending[0].id;
    const { hash } = await broker.preview(id, "p1");
    await broker.decide(id, { decision: "grant", projectId: "p1", hash });
    assert((await first).result);
    assert.match(
      (await ask(broker, { method: "context", params: {} })).result.text,
      /桌面机器人/,
    );
    assert.equal(broker.snapshot().log[0].result, "granted");
    const other = ask(broker, {
      method: "context",
      client: { name: "Cursor" },
      params: {},
    });
    await until(() => broker.pending.size === 1);
    await broker.decide(broker.snapshot().pending[0].id, { decision: "deny" });
    await other;
    const wrong = ask(broker, {
      method: "context",
      params: { project: "网站" },
    });
    await until(() => broker.pending.size === 1);
    await broker.decide(broker.snapshot().pending[0].id, { decision: "deny" });
    await wrong;
    clock += 31 * 60000;
    assert.equal(broker.snapshot().grants.length, 0);
    const expired = ask(broker, { method: "context", params: {} });
    await until(() => broker.pending.size === 1);
    broker.reset("工作空间已切换");
    assert.equal((await expired).error, "工作空间已切换");
  } finally {
    await broker.stop();
  }
});

test("changed content between preview and approval is refused", async () => {
  const { broker, state } = setup();
  await broker.start();
  try {
    const answer = ask(broker, {
      method: "context",
      params: { project: "桌面机器人" },
    });
    await until(() => broker.pending.size === 1);
    const id = broker.snapshot().pending[0].id;
    const { hash } = await broker.preview(id, "p1");
    state.project.goal = "改了";
    await assert.rejects(
      broker.decide(id, { decision: "once", projectId: "p1", hash }),
      /重新查看预览/,
    );
    await assert.rejects(broker.preview(id, "p-unknown"), /选择要分享/);
    const fresh = await broker.preview(id, "p1");
    await broker.decide(id, {
      decision: "once",
      projectId: "p1",
      hash: fresh.hash,
    });
    assert.match((await answer).result.text, /改了/);
  } finally {
    await broker.stop();
  }
});

test("proposals are sanitized into the inbox without approval", async () => {
  const { broker, state } = setup();
  const seen = [];
  broker.on("proposal", (p) => seen.push(p));
  await broker.start();
  try {
    const answer = await ask(broker, {
      method: "propose",
      client: { name: "Claude\u0007 Code" },
      params: {
        project: "桌面机器人",
        next: ["接屏幕", 5],
        completed: "not a list",
      },
    });
    assert.match(answer.result.text, /用户检查确认后才会保存/);
    const [, params] = state.calls.find(([m]) => m === "projects.handoff-add");
    assert.deepEqual(params, {
      client: "Claude Code",
      project: "桌面机器人",
      completed: [],
      blockers: [],
      next: ["接屏幕"],
      note: "",
    });
    assert.equal(seen[0].client.name, "Claude Code");
    assert.equal(broker.snapshot().log[0].result, "received");
  } finally {
    await broker.stop();
  }
  const failing = setup({ addError: "收件箱已满" }).broker;
  await failing.start();
  try {
    assert.equal(
      (await ask(failing, { method: "propose", params: {} })).error,
      "收件箱已满",
    );
  } finally {
    await failing.stop();
  }
});

test("lifecycle: stale socket, oversized frames, empty workspace", async () => {
  const { broker } = setup({ projects: [] });
  fs.writeFileSync(broker.socketPath, "stale");
  await broker.start();
  try {
    assert(broker.snapshot().listening);
    assert.match(
      (await ask(broker, { method: "context", params: {} })).error,
      /还没有项目/,
    );
    assert.match((await ask(broker, { method: "nope" })).error, /不支持/);
    const big = net.connect(broker.socketPath);
    const closed = new Promise((r) => big.on("close", r));
    big.on("error", () => {});
    big.write("x".repeat(300 * 1024));
    await closed;
  } finally {
    await broker.stop();
  }
  assert(!fs.existsSync(broker.socketPath));
  assert(!broker.snapshot().listening);
});
