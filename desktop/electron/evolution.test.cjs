const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EvolutionController,
  chooseForm,
  EVOLVE_MS,
  CINEMATIC_MS,
  RESULT_MS,
  DEEP_AFTER_MS,
} = require("./evolution.cjs");
function fixture(options = {}) {
  let now = 1000,
    next = 0;
  const timers = new Map(),
    changes = [],
    saved = [];
  const clock = {
    now: () => now,
    schedule: (fn, ms) => {
      const id = ++next;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (id) => timers.delete(id),
    tick: (ms) => {
      const end = now + ms;
      while (true) {
        const due = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
  };
  const controller = new EvolutionController({
    schedule: clock.schedule,
    cancel: clock.cancel,
    now: clock.now,
    changed: (s) => changes.push(s),
    persist: (s) => saved.push(s),
    ...options,
  });
  return { controller, clock, changes, saved };
}
test("form follows explicit effort or task plan; long artisan work dives deep", () => {
  assert.equal(chooseForm({ effort: "high" }), "deep");
  assert.equal(chooseForm({ effort: "ultra" }), "deep");
  assert.equal(chooseForm({ plannedSteps: 4 }), "deep");
  assert.equal(chooseForm({ effort: "low" }), "companion");
  const { controller: c, clock } = fixture();
  c.begin("report", { id: "r" });
  clock.tick(DEEP_AFTER_MS - 1);
  assert.equal(c.snapshot().live.form, "artisan");
  clock.tick(1);
  const live = c.snapshot().live;
  assert.equal(live.form, "deep");
  assert.equal(live.phase, "working"); // switched in place, no second evolution
  assert.equal(live.task.id, "r");
  clock.tick(600000);
  assert.equal(c.snapshot().live.form, "deep");
});
test("time spent waiting for the user does not count towards diving deep", () => {
  const { controller: c, clock } = fixture();
  c.begin("task", { id: "t" });
  clock.tick(15000);
  c.wait("task", "t");
  clock.tick(600000);
  assert.equal(c.snapshot().live.form, "artisan");
  assert.equal(c.snapshot().live.phase, "waiting");
  c.resume("task", "t");
  clock.tick(DEEP_AFTER_MS - 15000 - 1);
  assert.equal(c.snapshot().live.form, "artisan");
  clock.tick(1);
  assert.equal(c.snapshot().live.form, "deep");
});
test("chat, quick work and a manual artisan preference never dive", () => {
  const { controller: c, clock } = fixture();
  c.observe({ type: "chat.activity", data: { id: "c", status: "streaming" } });
  clock.tick(600000);
  assert.equal(c.snapshot().live.form, "companion");
  c.observe({ type: "chat.activity", data: { id: "c", status: "complete" } });
  c.begin("report", { id: "quick" });
  clock.tick(5000);
  c.finish("report", "quick", { ok: true, verified: true });
  clock.tick(600000);
  assert.notEqual(c.snapshot().live.form, "deep");
  c.configure({ enabled: true, mode: "artisan" });
  c.begin("report", { id: "manual" });
  clock.tick(600000);
  assert.equal(c.snapshot().live.form, "artisan");
});
test("a dive pending for a replaced, cancelled or reset task never fires", () => {
  const { controller: c, clock } = fixture();
  c.begin("report", { id: "a" });
  clock.tick(10000);
  c.begin("report", { id: "b" }); // replaces a; b's clock starts from zero
  clock.tick(DEEP_AFTER_MS - 1);
  assert.equal(c.snapshot().live.form, "artisan");
  c.cancel("report", "b");
  clock.tick(600000);
  assert.notEqual(c.snapshot().live.form, "deep");
  c.begin("task", { id: "t" });
  c.reset();
  clock.tick(600000);
  assert.equal(c.snapshot().live.form, "companion");
});
test("waiting requires a real resume or an explicit demo click", () => {
  const { controller: c, clock } = fixture();
  c.begin("task", { id: "t" });
  c.wait("task", "t");
  clock.tick(600000);
  assert.equal(c.snapshot().live.phase, "waiting");
  c.resume("task", "t");
  assert.equal(c.snapshot().live.phase, "working");
});
test("completion during evolution cancels old transition timer", () => {
  const { controller: c, clock } = fixture();
  c.begin("report", { id: "r" });
  c.finish("report", "r", { ok: true, verified: true });
  clock.tick(EVOLVE_MS + 1);
  assert.equal(c.snapshot().live.phase, "success");
  clock.tick(RESULT_MS + EVOLVE_MS);
  assert.equal(c.snapshot().live.form, "companion");
});
test("cancelled and replaced task replies cannot celebrate late", () => {
  const { controller: c, clock } = fixture();
  c.begin("report", { id: "old" });
  c.cancel("report", "old");
  c.begin("report", { id: "new", effort: "high" });
  assert.equal(c.finish("report", "old", { ok: true, verified: true }), false);
  clock.tick(1000);
  assert.equal(c.snapshot().live.task.id, "new");
  assert.equal(c.snapshot().lastCompleted, null);
});
test("repeated activity events do not restart an evolution", () => {
  const { controller: c, clock } = fixture();
  c.observe({ type: "job.changed", data: { id: "r", status: "queued" } });
  clock.tick(300);
  c.observe({ type: "job.changed", data: { id: "r", status: "running" } });
  clock.tick(CINEMATIC_MS - 200);
  assert.equal(c.snapshot().live.phase, "working");
});
test("approval disappearing is not proof of success", () => {
  const { controller: c, clock } = fixture();
  c.observe({ type: "handoff.changed", data: { pending: [{ id: "h" }] } });
  assert.equal(c.snapshot().live.phase, "waiting");
  c.observe({ type: "handoff.changed", data: { pending: [] } });
  clock.tick(5000);
  assert.equal(c.snapshot().live.form, "companion");
  assert.equal(c.snapshot().lastCompleted, null);
});
test("background completion restores another active task instead of interrupting it", () => {
  const { controller: c, clock } = fixture();
  c.begin("chat", { id: "c" });
  c.begin("report", { id: "r" });
  c.finish("report", "r", { ok: true, verified: true });
  clock.tick(1000);
  assert.equal(c.snapshot().live.task.id, "c");
  assert.equal(c.snapshot().live.phase, "working");
  assert.equal(c.snapshot().lastCompleted.kind, "report");
});
test("milestones require a verified real completion and explicit confirmation", () => {
  const { controller: c, clock, saved } = fixture();
  c.startDemo("deep");
  clock.tick(5000);
  c.continueDemo();
  clock.tick(5000);
  assert.equal(c.snapshot().lastCompleted, null);
  assert.throws(() => c.recordMilestone("demo"));
  c.begin("chat", { id: "chat" });
  c.finish("chat", "chat", { ok: true, verified: false });
  assert.equal(c.snapshot().lastCompleted, null);
  c.begin("report", { id: "real" });
  c.finish("report", "real", { ok: true, verified: true });
  assert.equal(c.snapshot().milestones.length, 0);
  c.recordMilestone("report:real");
  c.recordMilestone("report:real");
  assert.equal(c.snapshot().milestones.length, 1);
  assert.equal(saved.length, 1);
});
test("milestones survive restore but cannot unlock permissions or duplicate entries", () => {
  const { controller: c } = fixture();
  c.restore({
    enabled: true,
    mode: "deep",
    milestones: [
      { id: "r", kind: "report", createdAt: 100 },
      { id: "r", kind: "report", createdAt: 100 },
      { id: "evil", kind: "demo", createdAt: 100 },
    ],
  });
  assert.equal(c.snapshot().milestones.length, 1);
  assert.equal(c.snapshot().live.form, "companion");
  assert.equal(c.snapshot().settings.mode, "deep");
});
test("failed persistence does not change settings", () => {
  const { controller: c } = fixture({
    persist: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(() => c.configure({ enabled: false, mode: "deep" }));
  assert.deepEqual(c.snapshot().settings, {
    enabled: true,
    mode: "auto",
    transition: "cinematic",
  });
});
test("reset and stop-demo clear pending callbacks", () => {
  const { controller: c, clock } = fixture();
  c.begin("task", { id: "a" });
  c.startDemo("deep");
  c.reset();
  clock.tick(600000);
  assert.equal(c.snapshot().live.phase, "idle");
  assert.equal(c.snapshot().demo, null);
  assert.equal(c.snapshot().lastCompleted, null);
});
test("failed demo cannot turn into a delayed success", () => {
  const { controller: c, clock, changes } = fixture();
  c.startDemo("deep");
  clock.tick(CINEMATIC_MS + 1400);
  c.continueDemo();
  c.failDemo();
  const start = changes.length;
  clock.tick(6000);
  assert.equal(
    changes.slice(start).some((s) => s.demo?.phase === "success"),
    false,
  );
  assert.equal(c.snapshot().demo, null);
});
test("disabled live behavior remains off while isolated local demos still work", () => {
  const { controller: c } = fixture();
  c.configure({ enabled: false, mode: "auto" });
  c.observe({ type: "job.changed", data: { id: "r", status: "running" } });
  assert.equal(c.snapshot().live.form, "companion");
  c.startDemo("artisan");
  assert.equal(c.snapshot().demo.form, "artisan");
  assert.equal(c.snapshot().live.form, "companion");
});

test("ordinary chat stays companion without explicit work metadata", () => {
  const { controller: c, clock } = fixture();
  c.observe({ type: "chat.activity", data: { id: "c", status: "streaming" } });
  assert.equal(c.snapshot().live.form, "companion");
  assert.equal(c.snapshot().live.phase, "working");
  c.observe({ type: "chat.activity", data: { id: "c", status: "complete" } });
  clock.tick(RESULT_MS + 1);
  assert.equal(c.snapshot().live.phase, "idle");
  assert.equal(c.snapshot().lastCompleted, null);
});
test("default timers retain the browser global receiver", () => {
  const previousSet = globalThis.setTimeout,
    previousClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (...args) {
    assert.equal(this, globalThis);
    return previousSet(...args);
  };
  globalThis.clearTimeout = function (...args) {
    assert.equal(this, globalThis);
    return previousClear(...args);
  };
  try {
    const c = new EvolutionController();
    c.startDemo("deep");
    c.close();
  } finally {
    globalThis.setTimeout = previousSet;
    globalThis.clearTimeout = previousClear;
  }
});

test("cinematic, quick and none have their own transition timing", () => {
  for (const [transition, ms] of [
    ["cinematic", 2400],
    ["quick", 640],
    ["none", 0],
  ]) {
    const { controller: c, clock } = fixture();
    c.configure({ enabled: true, mode: "auto", transition });
    c.begin("report", { id: "r" });
    assert.equal(c.snapshot().live.transitionDurationMs, ms);
    if (ms) {
      assert.equal(c.snapshot().live.phase, "evolving");
      clock.tick(ms - 1);
      assert.equal(c.snapshot().live.phase, "evolving");
      clock.tick(1);
    }
    assert.equal(c.snapshot().live.phase, "working");
    c.finish("report", "r", { ok: true, verified: true });
    clock.tick(RESULT_MS + EVOLVE_MS + 1);
    assert.equal(c.snapshot().live.form, "companion");
  }
});
test("skip only ends a visual transition and never confirms a waiting task", () => {
  const { controller: c, clock } = fixture();
  c.begin("task", { id: "t" });
  c.skipLive();
  assert.equal(c.snapshot().live.phase, "working");
  c.wait("task", "t");
  c.skipLive();
  assert.equal(c.snapshot().live.phase, "waiting");
  assert.equal(c.snapshot().lastCompleted, null);
  clock.tick(10000);
  assert.equal(c.snapshot().live.phase, "waiting");
  c.startDemo("deep");
  clock.tick(100);
  c.skipDemo();
  assert.equal(c.snapshot().demo.stage, "working");
  clock.tick(1300);
  assert.equal(c.snapshot().demo.stage, "waiting");
  c.skipDemo();
  assert.equal(c.snapshot().demo.stage, "waiting");
  assert.equal(c.snapshot().milestones.length, 0);
});
test("none mode still waits for confirmation and never plays a return transition", () => {
  const { controller: c, clock } = fixture();
  c.configure({ enabled: true, mode: "auto", transition: "none" });
  c.startDemo("artisan");
  assert.equal(c.snapshot().demo.phase, "working");
  clock.tick(1300);
  assert.equal(c.snapshot().demo.phase, "waiting");
  c.continueDemo();
  clock.tick(1100 + RESULT_MS + 1);
  assert.equal(c.snapshot().demo, null);
});
test("older saved settings migrate safely and unknown transition styles reject", () => {
  const { controller: c } = fixture();
  c.restore({ enabled: true, mode: "auto" });
  assert.equal(c.snapshot().settings.transition, "cinematic");
  assert.throws(() =>
    c.configure({ enabled: true, mode: "auto", transition: "execute" }),
  );
  assert.equal(c.snapshot().settings.transition, "cinematic");
});
