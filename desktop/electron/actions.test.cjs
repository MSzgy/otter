const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ActionGate } = require("./actions.cjs");
test("actions execute only after confirmation and cannot replay", async () => {
  const ran = [];
  const gate = new ActionGate({
    resolveApp: async () => ({ name: "Calculator" }),
    execute: async (a) => ran.push(a),
  });
  const p = await gate.prepare({
    kind: "open_app",
    target: "com.apple.calculator",
  });
  assert.equal(ran.length, 0);
  assert.equal(p.description, "Calculator");
  await gate.confirm(p.id);
  assert.equal(ran.length, 1);
  await assert.rejects(gate.confirm(p.id), /过期/);
});
test("expired, canceled and unsafe actions never execute", async () => {
  let now = 1;
  const gate = new ActionGate({
    resolveApp: async () => null,
    execute: () => {
      throw new Error("unexpected");
    },
    now: () => now,
  });
  await assert.rejects(
    gate.prepare({ kind: "open_url", target: "file:///etc/passwd" }),
    /HTTP/,
  );
  await assert.rejects(
    gate.prepare({ kind: "open_app", target: "--args dangerous" }),
    /标识/,
  );
  await assert.rejects(gate.prepare({ kind: "shell", target: "rm" }), /不支持/);
  const p = await gate.prepare({
    kind: "open_url",
    target: "https://example.com",
  });
  now = 60002;
  await assert.rejects(gate.confirm(p.id), /过期/);
  const q = await gate.prepare({
    kind: "open_url",
    target: "https://example.com",
  });
  gate.cancel(q.id);
  await assert.rejects(gate.confirm(q.id), /过期/);
});
