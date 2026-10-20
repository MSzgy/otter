const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AssistantStore } = require("./assistant-store.cjs");
const { ActionGate } = require("./actions.cjs");
const { TaskAssistant } = require("./task-assistant.cjs");
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-tasks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.now(),
    next;
  const records = [],
    opened = [];
  const store = new AssistantStore(path.join(dir, "assistant.json"), {
    now: () => now,
  });
  const gate = new ActionGate({
    now: () => now,
    resolveApp: async () => ({ name: "Calculator" }),
    execute: async (a) => opened.push(a),
  });
  const tasks = new TaskAssistant({
    store,
    gate,
    now: () => now,
    interpret: async () => (typeof next === "function" ? next() : next),
    record: async (r) => records.push(r),
  });
  return {
    store,
    tasks,
    records,
    opened,
    gate,
    set: (p) => (next = p),
    advance: (ms) => (now += ms),
    now: () => now,
    plan: () =>
      tasks.plan({
        text: "用户直接要求",
        sessionId: "session",
        requestId: "request",
      }),
    confirm: (p) => tasks.confirm({ id: p.id, sessionId: "session" }),
  };
}
test("preview has no effects; confirmation and repeated confirmation create once with receipt", async (t) => {
  const h = setup(t);
  h.set({ kind: "reminder_create", title: "喝水", dueAt: h.now() + 600000 });
  const p = await h.plan();
  assert.equal(h.store.snapshot().reminders.length, 0);
  assert.equal(p.kind, "proposal");
  assert((await h.confirm(p)).ok);
  await h.confirm(p);
  assert.equal(h.store.snapshot().reminders.length, 1);
  assert.equal(h.records.length, 1);
  assert.equal(
    h.tasks.state("session").recent_target.id,
    h.store.snapshot().reminders[0].id,
  );
  assert.equal(h.tasks.state("other").recent_target, null);
});
test("expired, cancelled and modified targets do not execute", async (t) => {
  const h = setup(t);
  const r = h.store.create({
    requestId: "r",
    title: "喝水",
    dueAt: h.now() + 600000,
  });
  h.set({ kind: "reminder_update", id: r.id, dueAt: r.dueAt + 10000 });
  let p = await h.plan();
  h.store.change(r.id, "cancelled");
  assert.equal((await h.confirm(p)).ok, false);
  assert.equal(h.store.snapshot().reminders[0].status, "cancelled");
  h.set({ kind: "todo_add", title: "写代码" });
  p = await h.plan();
  h.advance(61000);
  assert.equal((await h.confirm(p)).ok, false);
  p = await h.plan();
  h.tasks.cancel("request");
  await assert.rejects(h.confirm(p));
  assert.equal(h.store.snapshot().todos.length, 0);
});
test("late analysis after cancellation cannot propose or execute", async (t) => {
  const h = setup(t);
  let finish;
  h.set(() => new Promise((resolve) => (finish = resolve)));
  const pending = h.plan();
  h.tasks.cancel("request");
  finish({ kind: "todo_add", title: "迟到任务" });
  assert.equal((await pending).kind, "cancelled");
  assert.equal(h.tasks.pending, null);
  assert.equal(h.records.length, 0);
});
test("reminder edit persists and resets due notification exactly once", async (t) => {
  const h = setup(t);
  const r = h.store.create({
    requestId: "r",
    title: "旧标题",
    dueAt: h.now() + 10,
  });
  h.advance(20);
  h.store.tick();
  h.set({
    kind: "reminder_update",
    id: r.id,
    title: "新标题",
    dueAt: h.now() + 100000,
  });
  assert((await h.confirm(await h.plan())).ok);
  const current = h.store.snapshot().reminders[0];
  assert.equal(current.status, "pending");
  assert.equal(current.notifiedAt, null);
  const reopened = new AssistantStore(h.store.file);
  assert.equal(reopened.snapshot().reminders[0].title, "新标题");
});
test("todos are added, queried and completed without toggling back", async (t) => {
  const h = setup(t);
  h.set({ kind: "todo_add", title: "测试任务" });
  await h.confirm(await h.plan());
  const item = h.store.snapshot().todos[0];
  h.set({ kind: "todo_complete", id: item.id });
  const p = await h.plan();
  await h.confirm(p);
  await h.confirm(p);
  assert(h.store.snapshot().todos[0].done);
  h.set({ kind: "todo_list", status: "active" });
  assert((await h.plan()).message.includes("共 0 条"));
  h.set({ kind: "todo_list", status: "done" });
  assert((await h.plan()).message.includes("测试任务"));
});
test("links and apps use existing gate; invalid scheme never executes", async (t) => {
  const h = setup(t);
  h.set({ kind: "open_url", target: "javascript:alert(1)" });
  await assert.rejects(h.plan());
  h.set({ kind: "open_app", target: "com.apple.calculator" });
  const p = await h.plan();
  assert.equal(h.opened.length, 0);
  await h.confirm(p);
  await h.confirm(p);
  assert.equal(h.opened.length, 1);
});
test("failed execution and failed chat receipt are reported separately", async (t) => {
  const h = setup(t);
  h.set({ kind: "todo_add", title: "任务" });
  let p = await h.plan();
  h.store.persist = () => {
    throw Object.assign(new Error("disk"), { code: "ENOSPC" });
  };
  assert.equal((await h.confirm(p)).ok, false);
  assert.equal(h.store.snapshot().todos.length, 0);
  h.set({ kind: "open_url", target: "https://example.com/" });
  p = await h.plan();
  h.tasks.record = async () => {
    throw new Error("offline");
  };
  const result = await h.confirm(p);
  assert(result.ok && result.warning.includes("未能写入聊天"));
  assert.equal(h.opened.length, 1);
});
test("large state is bounded and work sessions are not sent", (t) => {
  const h = setup(t);
  h.store.data.todos = Array.from({ length: 500 }, (_, i) => ({
    id: String(i),
    title: "中".repeat(200),
    done: false,
  }));
  h.store.data.sessions = [{ context: "PRIVATE_WORK" }];
  const state = h.tasks.state("session");
  assert(state.truncated);
  assert(Buffer.byteLength(JSON.stringify(state)) < 25000);
  assert(!JSON.stringify(state).includes("PRIVATE_WORK"));
});
test("date query uses configured timezone and includes due reminders", async (t) => {
  const h = setup(t);
  const when = h.now() + 3600000;
  h.store.create({ requestId: "r", title: "测试提醒", dueAt: when });
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
  h.set({ kind: "reminder_list", status: "active", date: day });
  assert((await h.plan()).message.includes("测试提醒"));
  h.set({ kind: "reminder_list", status: "active", date: "2001-01-01" });
  assert((await h.plan()).message.includes("共 0 条"));
});
test("target changes during model analysis require a new plan", async (t) => {
  const h = setup(t);
  let finish;
  const r = h.store.create({
    requestId: "r",
    title: "喝水",
    dueAt: h.now() + 100000,
  });
  h.set(() => new Promise((resolve) => (finish = resolve)));
  const pending = h.plan();
  h.store.updateReminder(r.id, { dueAt: r.dueAt + 3600000 });
  finish({ kind: "reminder_update", id: r.id, dueAt: r.dueAt + 1800000 });
  await assert.rejects(pending, /理解期间.*变化/);
  assert.equal(h.tasks.pending, null);
  assert.equal(h.store.snapshot().reminders[0].dueAt, r.dueAt + 3600000);
});
test("project-derived actions verify project revision before opening or writing", async (t) => {
  const h = setup(t);
  h.tasks.projectAction = async () => ({
    kind: "todo_add",
    title: "项目下一步",
    projectId: "p",
    sourceKey: "snapshot:item",
    project_ref: { project_id: "p", revision: 1 },
  });
  h.tasks.checkProject = async () => {
    throw new Error("项目已更新");
  };
  h.set({ kind: "project_todo", project_id: "p" });
  assert.equal((await h.confirm(await h.plan())).ok, false);
  assert.equal(h.store.snapshot().todos.length, 0);
  h.tasks.checkProject = async () => ({ ok: true });
  await h.confirm(await h.plan());
  await h.confirm(await h.plan());
  assert.equal(h.store.snapshot().todos.length, 1);
  assert.equal(h.store.snapshot().todos[0].projectId, "p");
});
test("project scope is applied before bounding the task list", (t) => {
  const h = setup(t);
  h.store.data.todos = [
    ...Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      title: "其他项目任务",
      done: false,
      projectId: "other",
    })),
    { id: "target", title: "当前项目任务", done: false, projectId: "current" },
  ];
  assert.deepEqual(
    h.tasks.state("session", "current").todos.map((t) => t.id),
    ["target"],
  );
});
