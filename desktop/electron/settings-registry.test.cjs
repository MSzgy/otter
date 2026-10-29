const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SettingsRegistry } = require("./settings-registry.cjs");
const { TaskAssistant } = require("./task-assistant.cjs");

function registry(values = {}) {
  const state = { quiet: false, theme: "warm", limit: 6, name: "", ...values };
  const writes = [];
  const reg = new SettingsRegistry([
    {
      id: "quiet",
      label: "安静模式",
      type: "switch",
      read: () => state.quiet,
      write: (v) => writes.push(["quiet", (state.quiet = v)]),
    },
    {
      id: "theme",
      label: "主题",
      type: "choice",
      options: [
        { value: "warm", label: "暖阳小窝" },
        { value: "night", label: "夜里小窝" },
      ],
      read: () => state.theme,
      write: (v) => writes.push(["theme", (state.theme = v)]),
    },
    {
      id: "ambient.dailyLimit",
      label: "陪伴每天最多",
      type: "number",
      min: 1,
      max: 30,
      unit: " 次",
      read: async () => state.limit,
      write: async (v) => writes.push(["limit", (state.limit = v)]),
    },
    {
      id: "memory.nickname",
      label: "称呼",
      type: "text",
      max: 40,
      read: () => state.name,
      write: (v) => (state.name = v),
    },
    {
      id: "body.enabled",
      label: "连接实体水獭",
      type: "switch",
      read: () => {
        throw new Error("not ready");
      },
      write: () => {},
    },
  ]);
  return { reg, state, writes };
}

test("values outside a setting's type, options or range are refused", () => {
  const { reg } = registry();
  assert.equal(reg.validate("quiet", true), true);
  assert.equal(reg.validate("theme", "night"), "night");
  assert.equal(reg.validate("memory.nickname", "  小杨 "), "小杨");
  for (const [id, value] of [
    ["quiet", "true"],
    ["theme", "neon"],
    ["ambient.dailyLimit", 31],
    ["ambient.dailyLimit", 2.5],
    ["memory.nickname", ""],
    ["memory.nickname", "x".repeat(41)],
  ])
    assert.throws(() => reg.validate(id, value), /不能设成/);
  assert.throws(() => reg.validate("models.api_key", "x"), /不能在聊天里改/);
});

test("rows describe each setting with its current value and skip ones not ready", async () => {
  const { reg } = registry({ quiet: true });
  const rows = await reg.rows();
  assert.deepEqual(
    rows.map((r) => r.id),
    ["quiet", "theme", "ambient.dailyLimit", "memory.nickname"],
  );
  assert.equal(rows[0].current, true);
  assert.deepEqual(rows[2], {
    id: "ambient.dailyLimit",
    label: "陪伴每天最多",
    type: "number",
    min: 1,
    max: 30,
    unit: " 次",
    current: 6,
  });
  assert.equal(reg.format("theme", "night"), "夜里小窝");
  assert.equal(reg.format("quiet", false), "关");
  assert.equal(reg.format("ambient.dailyLimit", 8), "8 次");
});

function assistant(t, plan, values) {
  const { reg, state, writes } = registry(values);
  const records = [];
  const tasks = new TaskAssistant({
    store: { snapshot: () => ({ reminders: [], todos: [] }) },
    gate: { cancel() {} },
    settings: reg,
    interpret: async (params) => {
      t.seen = params.state.settings;
      return typeof plan === "function" ? plan() : plan;
    },
    record: async (r) => records.push(r),
  });
  const ask = () =>
    tasks.plan({ text: "改设置", sessionId: "s", requestId: "r" });
  return { tasks, state, writes, records, ask, set: (p) => (plan = p) };
}

test("a setting changes only after confirmation, and 撤销 puts it back", async (t) => {
  const h = assistant(t, {
    kind: "setting_change",
    id: "theme",
    value: "night",
  });
  const proposal = await h.ask();
  assert.equal(t.seen.find((r) => r.id === "theme").current, "warm");
  assert.equal(proposal.kind, "proposal");
  assert.equal(proposal.detail, "主题：暖阳小窝 → 夜里小窝");
  assert.equal(h.state.theme, "warm", "Planning changes nothing");
  const done = await h.tasks.confirm({ id: proposal.id, sessionId: "s" });
  assert.equal(done.ok, true);
  assert.equal(done.message, "已把主题改为夜里小窝。");
  assert.deepEqual(done.undo, { id: "theme", label: "主题" });
  assert.equal(h.state.theme, "night");
  assert.deepEqual(h.tasks.state("s").recent_target, {
    id: "theme",
    kind: "setting",
    previous: "warm",
  });
  const undone = await h.tasks.undoSetting({ sessionId: "s" });
  assert.equal(undone.message, "已撤销：主题改回暖阳小窝。");
  assert.equal(h.state.theme, "warm");
  await assert.rejects(h.tasks.undoSetting({ sessionId: "s" }), /没有可以撤销/);
  assert.equal(h.records.length, 2, "Both outcomes are written to the chat");
});

test("no change, a moved setting and a late undo are all refused", async (t) => {
  const h = assistant(t, { kind: "setting_change", id: "quiet", value: true });
  h.state.quiet = true;
  const same = await h.ask();
  assert.equal(same.kind, "result");
  assert.match(same.message, /已经是开，不用改/);
  h.state.quiet = false;
  const proposal = await h.ask();
  h.state.quiet = true; // changed by hand before confirming
  const result = await h.tasks.confirm({ id: proposal.id, sessionId: "s" });
  assert.equal(result.ok, false);
  assert.match(result.message, /刚刚被改过/);
  assert.equal(result.undo, undefined);
  h.state.quiet = false;
  const again = await h.ask();
  await h.tasks.confirm({ id: again.id, sessionId: "s" });
  h.state.quiet = false; // changed back by hand after the chat change
  await assert.rejects(h.tasks.undoSetting({ sessionId: "s" }), /之后又被改过/);
  assert.deepEqual(h.writes, [["quiet", true]]);
});

test("asking about settings answers from the live values", async (t) => {
  const h = assistant(
    t,
    { kind: "setting_query", id: "quiet" },
    { quiet: true },
  );
  assert.equal((await h.ask()).message, "安静模式：开。");
  h.set({ kind: "setting_query" });
  const all = (await h.ask()).message;
  assert.match(all, /• 主题：暖阳小窝/);
  assert.match(all, /• 陪伴每天最多：6 次/);
  assert.match(all, /模型、密钥和工作空间请到设置里手动改/);
});
