const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Ambient } = require("./ambient.cjs");
test("ambient is opt-in and respects all suppression conditions", () => {
  const p = new Ambient();
  assert.equal(p.event("report"), null);
  p.configure({ enabled: true, cooldownMinutes: 1, dailyLimit: 2 });
  for (const key of ["quiet", "focus", "busy", "sleeping"])
    assert.equal(p.event("report", { [key]: true }, 100000), null);
  assert.equal(p.snapshot().state.count, 0);
});
test("cooldown and daily cap survive serialization", () => {
  let p = new Ambient();
  p.configure({ enabled: true, cooldownMinutes: 1, dailyLimit: 2 });
  assert(p.event("coding", {}, 100000));
  assert.equal(p.event("report", {}, 110000), null);
  p = new Ambient(p.snapshot());
  assert(p.event("report", {}, 170000));
  assert.equal(p.event("focus", {}, 250000), null);
});
test("disabled policy never emits or counts an event", () => {
  const p = new Ambient();
  p.configure({ enabled: false, cooldownMinutes: 15, dailyLimit: 6 });
  assert.equal(p.event("focus", {}, Date.now()), null);
  assert.equal(p.snapshot().state.count, 0);
});
