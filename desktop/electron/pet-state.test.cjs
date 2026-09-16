const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PetState, ACTIONS } = require("./pet-state.cjs");
test("actions have distinct effects and expire back to idle", () => {
  const pet = new PetState();
  let now = 10000;
  for (const action of ["pet", "feed", "play", "dance", "wave", "tickle"]) {
    const result = pet.interact(action, now);
    assert.equal(result.effect.action, action);
    assert.equal(result.mood, ACTIONS[action].mood);
    assert.equal(pet.snapshot(now + 5000).mood, "idle");
    now += 10000;
  }
  assert.equal(pet.snapshot(now).interactions, 6);
});
test("cooldown rejects without counting or replacing the effect", () => {
  const pet = new PetState();
  pet.interact("feed", 10000);
  assert.throws(() => pet.interact("feed", 10500), /还没吃完/);
  assert.equal(pet.snapshot(10500).interactions, 1);
  assert.equal(pet.snapshot(10500).effect.expiresAt, 13800);
  pet.interact("feed", 18000);
  assert.equal(pet.snapshot(18000).interactions, 2);
});
test("sleep survives restart; wake restores interaction; quiet is unrelated", () => {
  const pet = new PetState();
  pet.interact("sleep", 10000);
  assert.equal(pet.snapshot(20000).mood, "sleeping");
  const restored = new PetState(pet.persisted());
  assert(restored.snapshot(21000).asleep);
  assert.throws(() => restored.interact("play", 21000), /睡觉/);
  restored.interact("wake", 22000);
  assert.equal(restored.snapshot(26000).mood, "idle");
  assert.equal(restored.snapshot(26000).interactions, 2);
});
test("unknown actions and malformed stored values do not mutate state", () => {
  const pet = new PetState({
    asleep: "yes",
    interactions: -9,
    lastAction: "constructor",
  });
  assert.throws(() => pet.interact("constructor"), /不认识/);
  assert.equal(pet.snapshot().interactions, 0);
  assert.equal(pet.snapshot().asleep, false);
});
