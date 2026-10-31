const test = require("node:test");
const assert = require("node:assert/strict");
const { SyncHub, diff, apply } = require("./sync-hub.cjs");

const roundTrip = (a, b) => {
  const ops = diff(a, b);
  assert.deepEqual(apply(a, ops), b, JSON.stringify(ops));
  return ops;
};

test("patches carry only what changed, and apply back exactly", () => {
  const a = {
    status: { online: true, version: "0.12.0" },
    todos: [
      { id: "1", title: "买牛奶", done: false },
      { id: "2", title: "修舵机", done: false },
    ],
  };
  const done = roundTrip(a, {
    ...a,
    todos: [a.todos[0], { ...a.todos[1], done: true }],
  });
  assert.deepEqual(done, [
    {
      o: "l",
      p: ["todos"],
      u: [{ id: "2", title: "修舵机", done: true }],
      r: [],
    },
  ]);
  assert.deepEqual(
    roundTrip(a, { ...a, status: { ...a.status, online: false } }),
    [{ o: "s", p: ["status", "online"], v: false }],
  );
  // Added at the end: no order sent. Removed, moved, added in front: order.
  const added = roundTrip(a, {
    ...a,
    todos: [...a.todos, { id: "3", title: "新" }],
  });
  assert.equal(added[0].i, undefined);
  const moved = roundTrip(a, { ...a, todos: [a.todos[1], a.todos[0]] });
  assert.deepEqual(moved[0].i, ["2", "1"]);
  roundTrip(a, { ...a, todos: [{ id: "0", title: "最前" }, a.todos[1]] });
  roundTrip(a, { status: a.status });
  roundTrip(a, { ...a, extra: [1, 2, 3] });
  roundTrip(a, null);
  roundTrip({ todos: [] }, { todos: [{ id: 1, x: 1 }] });
  assert.deepEqual(diff(a, structuredClone(a)), []);
});

test("a growing reply travels as appended text", () => {
  const start = {
    turn: { id: "t", status: "streaming", content: "水獭".repeat(20) },
  };
  const more = {
    turn: { ...start.turn, content: start.turn.content + "，今天天气不错。" },
  };
  assert.deepEqual(roundTrip(start, more), [
    { o: "a", p: ["turn", "content"], t: "，今天天气不错。" },
  ]);
  // A rewrite (or a short string) is set whole.
  assert.equal(
    roundTrip(more, { turn: { ...more.turn, content: "重新开始" } })[0].o,
    "s",
  );
});

test("the hub numbers patches, coalesces bursts, and catches phones up", async () => {
  let value = { n: 0, items: [] };
  let reads = 0;
  const hub = new SyncHub({
    sources: {
      today: () => {
        reads++;
        return structuredClone(value);
      },
    },
    delays: { today: 5 },
  });
  // Nothing is read while nobody listens.
  hub.touch("today");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads, 0);
  const [snap] = await hub.catchUp({});
  assert.equal(snap.t, "snap");
  assert.equal(snap.seq, 1);
  const patches = [];
  hub.listen((p) => patches.push(p));
  for (let i = 1; i <= 5; i++) {
    value = { ...value, n: i };
    hub.touch("today");
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(patches.length, 1, "five quick changes, one patch");
  assert.deepEqual(patches[0].ops, [{ o: "s", p: ["n"], v: 5 }]);
  assert.equal(patches[0].seq, 2);
  value = { ...value, items: [{ id: "a" }] };
  hub.touch("today");
  await new Promise((r) => setTimeout(r, 30));
  // A phone at seq 1 of this epoch gets the two patches; another epoch or a
  // seq too old gets a snapshot; an up-to-date one gets nothing.
  const behind = await hub.catchUp({ epoch: hub.epoch, seqs: { today: 1 } });
  assert.deepEqual(
    behind.map((f) => [f.t, f.seq]),
    [
      ["patch", 2],
      ["patch", 3],
    ],
  );
  assert.deepEqual(
    apply(
      snap.value,
      behind.flatMap((p) => p.ops),
    ),
    value,
  );
  assert.equal(
    (await hub.catchUp({ epoch: "other", seqs: { today: 3 } }))[0].t,
    "snap",
  );
  assert.deepEqual(
    await hub.catchUp({ epoch: hub.epoch, seqs: { today: 3 } }),
    [],
  );
  for (let i = 0; i < 70; i++) {
    value = { ...value, n: 100 + i };
    await hub.refresh("today");
  }
  assert.equal(
    (await hub.catchUp({ epoch: hub.epoch, seqs: { today: 3 } }))[0].t,
    "snap",
    "only the last 64 patches are kept",
  );
  hub.stop();
});

test("a change while the app is being read is not lost", async () => {
  let value = 1;
  let release;
  const hub = new SyncHub({
    sources: {
      status: () =>
        value === 2
          ? new Promise((r) => {
              release = () => r({ v: 2 });
            })
          : { v: value },
    },
  });
  await hub.catchUp({});
  const patches = [];
  hub.listen((p) => patches.push(p));
  value = 2;
  const first = hub.refresh("status");
  value = 3;
  void hub.refresh("status");
  release();
  await first;
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    patches.map((p) => p.ops[0].v),
    [2, 3],
  );
  hub.stop();
});
