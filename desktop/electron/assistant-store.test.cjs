const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AssistantStore } = require("./assistant-store.cjs");
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-reminder-"));
  return {
    file: path.join(dir, "assistant.json"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
test("reminders persist, deduplicate and notify once across restart", () => {
  const env = setup();
  let now = 10000,
    events = [];
  try {
    let store = new AssistantStore(env.file, {
      now: () => now,
      notify: (x) => events.push(x),
    });
    const params = { title: "Drink water", dueAt: 12000, requestId: "one" };
    store.create(params);
    store.create(params);
    assert.equal(store.snapshot().reminders.length, 1);
    store = new AssistantStore(env.file, {
      now: () => now,
      notify: (x) => events.push(x),
    });
    now = 13000;
    store.tick();
    store.tick();
    assert.equal(events.length, 1);
    assert.equal(store.snapshot().reminders[0].status, "due");
    new AssistantStore(env.file, {
      now: () => now,
      notify: (x) => events.push(x),
    }).tick();
    assert.equal(events.length, 1);
  } finally {
    env.cleanup();
  }
});
test("wake-up backlog is one notification and canceled reminders never fire", () => {
  const env = setup();
  let now = 10000,
    events = [];
  try {
    const store = new AssistantStore(env.file, {
      now: () => now,
      notify: (x) => events.push(x),
    });
    for (let i = 0; i < 3; i++)
      store.create({
        title: "Reminder " + i,
        dueAt: 12000,
        requestId: String(i),
      });
    store.change(store.snapshot().reminders[0].id, "cancelled");
    now = 200000;
    store.tick();
    assert.equal(events.length, 1);
    assert.equal(events[0].late, true);
    assert(events[0].title.includes("2"));
  } finally {
    env.cleanup();
  }
});
test("focus is singular and cancelled focus releases the slot", () => {
  const env = setup();
  try {
    const store = new AssistantStore(env.file);
    const r = store.create({
      title: "Focus",
      dueAt: Date.now() + 100000,
      requestId: "a",
      kind: "focus",
    });
    assert.throws(
      () =>
        store.create({
          title: "Other",
          dueAt: Date.now() + 100000,
          requestId: "b",
          kind: "focus",
        }),
      /已有专注/,
    );
    store.change(r.id, "cancelled");
    assert.equal(store.snapshot().focus, null);
    assert.throws(
      () => store.create({ title: "Past", dueAt: 1, requestId: "c" }),
      /未来/,
    );
  } finally {
    env.cleanup();
  }
});
test("saved work and todos survive restart and can be removed", () => {
  const env = setup();
  try {
    const store = new AssistantStore(env.file);
    const todo = store.addTodo({ title: "Test task" });
    store.changeTodo(todo.id, false);
    const work = store.saveSession({
      title: "Work",
      context: "Page context",
      question: "Question",
      nextStep: "Next step",
    });
    const again = new AssistantStore(env.file);
    assert(again.snapshot().todos[0].done);
    assert.equal(again.getSession(work.id).nextStep, "Next step");
    again.deleteSession(work.id);
    again.changeTodo(todo.id, true);
    assert.equal(again.snapshot().sessions.length, 0);
    assert.equal(again.snapshot().todos.length, 0);
  } finally {
    env.cleanup();
  }
});
test("duplicate requests after their due time return the original reminder", () => {
  const env = setup();
  let now = 1000;
  try {
    const store = new AssistantStore(env.file, { now: () => now });
    const params = { title: "Test", dueAt: 2000, requestId: "duplicate" };
    const original = store.create(params);
    now = 3000;
    assert.equal(store.create(params).id, original.id);
    assert.equal(store.snapshot().reminders.length, 1);
  } finally {
    env.cleanup();
  }
});
