const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ToolHost } = require("./tool-host.cjs");

function host(tools, options = {}) {
  const changes = [];
  const h = new ToolHost({
    sources: [{ list: () => tools }],
    onChange: (pending) => changes.push(pending),
    ...options,
  });
  return { h, changes };
}
const call = (name, extra = {}) => ({
  call_id: "c" + Math.random(),
  turn_id: "t",
  session_id: "s",
  name,
  arguments: {},
  ...extra,
});
const lookup = {
  name: "otter_time",
  label: "看时间",
  readOnly: true,
  trusted: true,
  run: () => "10:00",
};
const write = {
  name: "notes_add",
  label: "记笔记",
  origin: "笔记",
  run: (args) => ({ saved: args.text }),
};

test("Otter's own look-ups run at once; definitions are Chat Completions tools", async () => {
  const { h, changes } = host([lookup, { ...lookup, label: "duplicate" }]);
  assert.deepEqual(await h.handle(call("otter_time")), {
    ok: true,
    content: "10:00",
    label: "看时间",
  });
  assert.equal(changes.length, 0, "No card for a trusted look-up");
  assert.deepEqual(h.definitions(), [
    {
      type: "function",
      function: {
        name: "otter_time",
        description: "看时间",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
});

test("other tools wait for the card; deny, once and this-conversation", async () => {
  const { h, changes } = host([write]);
  const denied = h.handle(call("notes_add", { arguments: { text: "a" } }));
  assert.equal(h.pending().length, 1);
  assert.deepEqual(h.pending()[0].arguments, { text: "a" });
  assert.equal(h.pending()[0].origin, "笔记");
  h.decide(h.pending()[0].id, "deny");
  const refusal = await denied;
  assert.equal(refusal.ok, false);
  assert.match(refusal.content, /没有允许/);

  const once = h.handle(call("notes_add", { arguments: { text: "b" } }));
  h.decide(h.pending()[0].id, "once");
  assert.equal((await once).content, '{\n "saved": "b"\n}');
  const again = h.handle(call("notes_add"));
  assert.equal(h.pending().length, 1, "Once means once");
  h.decide(h.pending()[0].id, "session");
  await again;
  assert.equal((await h.handle(call("notes_add"))).ok, true, "No card now");
  assert.equal(h.pending().length, 0);
  const other = h.handle(call("notes_add", { session_id: "other" }));
  assert.equal(h.pending().length, 1, "The grant is for one conversation");
  h.cancelTurn("t");
  assert.equal((await other).ok, false, "A stopped reply drops its card");
  assert(changes.length >= 6);
});

test("unknown tools, errors, slow tools and unanswered cards all come back as text", async () => {
  const { h } = host(
    [
      { ...lookup, name: "boom", run: () => Promise.reject(new Error("坏了")) },
      { ...lookup, name: "slow", run: () => new Promise(() => {}) },
      { ...lookup, name: "big", run: () => "x".repeat(20000) },
      write,
    ],
    { runTimeout: 20, askTimeout: 20 },
  );
  assert.equal((await h.handle(call("nope"))).content, "没有这个工具。");
  assert.equal((await h.handle(call("boom"))).content, "工具出错：坏了");
  assert.match((await h.handle(call("slow"))).content, /超时/);
  assert.match((await h.handle(call("big"))).content, /已截断/);
  assert.equal((await h.handle(call("notes_add"))).ok, false);
  assert.throws(() => h.decide("missing", "once"), /已经结束/);
});

test("tools the backend would refuse are left out of the offer", () => {
  const huge = {
    type: "object",
    properties: { x: { description: "y".repeat(13000) } },
  };
  const { h } = host([
    lookup,
    { ...lookup, name: "bad name" },
    { ...lookup, name: "huge", parameters: huge },
    ...Array.from({ length: 70 }, (_, i) => ({ ...lookup, name: `t${i}` })),
  ]);
  const names = h.definitions().map((d) => d.function.name);
  assert.equal(names.length, 64);
  assert(!names.includes("bad name") && !names.includes("huge"));
});
