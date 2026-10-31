// SyncHub: the desktop's state as a few topics a phone can follow. Each topic
// is a plain JSON value read from the app (today, chat, agents, otter,
// status); when something changes the hub reads it again, works out the
// smallest patch from the last value it sent, numbers it, and hands it to
// every listener. A phone that comes back with "epoch E, topic at seq N" gets
// only the patches after N while they are still kept, else a fresh snapshot.
//
// Patches are lists of ops on paths into the value:
//   { o: "s", p: [...], v }            set (v undefined = delete the key)
//   { o: "a", p: [...], t }            append text to a string (streaming)
//   { o: "l", p: [...], u, r, i }      list of {id} items: upsert u, remove
//                                      ids r, and i = the new id order when
//                                      it changed
const { randomUUID } = require("node:crypto");

const KEEP = 64;
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keyed = (v) =>
  Array.isArray(v) &&
  v.every(
    (x) => plain(x) && (typeof x.id === "string" || typeof x.id === "number"),
  );
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diff(prev, next, path = [], ops = []) {
  if (prev === next || same(prev, next)) return ops;
  if (plain(prev) && plain(next)) {
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)]))
      if (!(k in next)) ops.push({ o: "s", p: [...path, k] });
      else diff(prev[k], next[k], [...path, k], ops);
    return ops;
  }
  if (keyed(prev) && keyed(next) && (prev.length || next.length)) {
    const before = new Map(prev.map((x) => [String(x.id), x]));
    const ids = next.map((x) => String(x.id));
    const u = next.filter((x) => !same(before.get(String(x.id)), x));
    const r = [...before.keys()].filter((id) => !ids.includes(id));
    const kept = prev.map((x) => String(x.id)).filter((id) => ids.includes(id));
    const order = ids.filter((id) => before.has(id));
    const op = { o: "l", p: path, u, r };
    // The order only travels when it changed or new items went anywhere but
    // the end; the phone otherwise appends new ones.
    const appended =
      same(order, kept) && same(ids.slice(0, order.length), order);
    if (!appended) op.i = ids;
    ops.push(op);
    return ops;
  }
  if (
    typeof prev === "string" &&
    typeof next === "string" &&
    prev.length >= 32 &&
    next.startsWith(prev)
  ) {
    ops.push({ o: "a", p: path, t: next.slice(prev.length) });
    return ops;
  }
  ops.push({ o: "s", p: path, v: next });
  return ops;
}

// The phone's side of diff, here for tests and the Node client.
function apply(value, ops) {
  let root = structuredClone(value);
  for (const op of ops) {
    if (!op.p.length) {
      if (op.o === "s") root = structuredClone(op.v);
      else if (op.o === "a") root += op.t;
      else root = list(root, op);
      continue;
    }
    let at = root;
    for (const k of op.p.slice(0, -1)) {
      if (!plain(at[k])) at[k] = {};
      at = at[k];
    }
    const last = op.p.at(-1);
    if (op.o === "s") {
      if (op.v === undefined) delete at[last];
      else at[last] = structuredClone(op.v);
    } else if (op.o === "a") at[last] = (at[last] || "") + op.t;
    else at[last] = list(at[last] || [], op);
  }
  return root;
}
function list(items, op) {
  const map = new Map(items.map((x) => [String(x.id), x]));
  for (const id of op.r) map.delete(id);
  const order = op.i || [
    ...items.map((x) => String(x.id)).filter((id) => map.has(id)),
  ];
  for (const x of op.u) {
    const id = String(x.id);
    if (!op.i && !map.has(id)) order.push(id);
    map.set(id, structuredClone(x));
  }
  return order.filter((id) => map.has(id)).map((id) => map.get(id));
}

class SyncHub {
  // sources: { topic: () => value | Promise<value> }; delays: per topic ms.
  constructor({ sources, delays = {}, now = Date.now }) {
    this.sources = sources;
    this.delays = delays;
    this.now = now;
    this.epoch = randomUUID().slice(0, 8);
    this.topics = new Map(
      Object.keys(sources).map((t) => [
        t,
        { seq: 0, value: null, patches: [], timer: null, reading: null },
      ]),
    );
    this.listeners = new Set();
  }
  // Something about a topic may have changed: read it again soon, once.
  touch(topic) {
    const t = this.topics.get(topic);
    if (!t || t.timer || !this.listeners.size) return;
    // Latency is measured from the change, not from the read after it.
    t.touched = this.now();
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.refresh(topic);
    }, this.delays[topic] ?? 16);
  }
  async refresh(topic) {
    const t = this.topics.get(topic);
    // One read at a time; a change during it reads once more after.
    if (t.reading) {
      t.again = true;
      return t.reading;
    }
    t.reading = (async () => {
      let next;
      try {
        next = await this.sources[topic]();
      } catch {
        return;
      }
      if (next === undefined) return;
      if (t.seq === 0) {
        t.value = next;
        t.seq = 1;
        return;
      }
      const ops = diff(t.value, next);
      const at = t.touched ?? this.now();
      t.touched = null;
      if (!ops.length) return;
      t.value = next;
      t.seq++;
      const patch = { t: "patch", topic, seq: t.seq, ops, at };
      t.patches.push(patch);
      if (t.patches.length > KEEP) t.patches.shift();
      for (const listener of this.listeners) listener(patch);
    })();
    try {
      await t.reading;
    } finally {
      t.reading = null;
    }
    if (t.again) {
      t.again = false;
      await this.refresh(topic);
    }
  }
  // What a phone needs to catch up: patches after its seq, or a snapshot.
  async catchUp(since = {}) {
    const out = [];
    for (const [topic, t] of this.topics) {
      // Nothing is read while no phone listens, so read everything now; a
      // phone that is behind gets the change as one more patch.
      await this.refresh(topic);
      if (t.seq === 0) continue;
      const seen = since.epoch === this.epoch ? since.seqs?.[topic] : undefined;
      if (seen === t.seq) continue;
      const missing = t.patches.filter((p) => p.seq > seen);
      if (
        Number.isInteger(seen) &&
        seen < t.seq &&
        missing.length === t.seq - seen
      )
        out.push(...missing);
      else
        out.push({
          t: "snap",
          topic,
          seq: t.seq,
          epoch: this.epoch,
          value: t.value,
          at: this.now(),
        });
    }
    return out;
  }
  listen(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  stop() {
    for (const t of this.topics.values()) clearTimeout(t.timer);
    this.listeners.clear();
  }
}

module.exports = { SyncHub, diff, apply };
