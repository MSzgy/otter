const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { SyncHub } = require("./sync-hub.cjs");
const { MobileLink } = require("./mobile.cjs");
const { readPairingLink } = require("./sync-crypto.cjs");
const { SyncClient } = require("../scripts/sync-client.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-mobile-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(5);
  }
}

function setup(extra = {}) {
  const state = {
    today: { todos: [{ id: "1", title: "买牛奶", done: false }] },
    status: { online: true },
  };
  const hub = new SyncHub({
    sources: {
      today: () => structuredClone(state.today),
      status: () => structuredClone(state.status),
    },
  });
  let saved = null;
  const link = new MobileLink({
    hub,
    dir: path.join(dir, `mac-${Math.random()}`),
    port: 0,
    host: "127.0.0.1",
    bonjour: null,
    name: "测试 Mac",
    load: () => saved,
    save: (v) => (saved = structuredClone(v)),
    requests: { echo: async (p) => ({ back: p.text }) },
    ...extra,
  });
  return { hub, link, state, saved: () => saved };
}
const client = (link, options = {}) =>
  SyncClient.fromLink(link.snapshot().pairing.link, {
    address: "127.0.0.1",
    ...options,
  });

test("off by default; nothing listens and pairing is refused", async () => {
  const { link } = setup();
  assert.equal(link.snapshot().listening, false);
  assert.throws(() => link.startPairing(), /允许手机连接/);
  await link.setEnabled(true);
  assert.equal(link.snapshot().listening, true);
  await link.setEnabled(false);
  assert.equal(link.snapshot().listening, false);
});

test("pair, follow the desktop, ask for data, report latency", async () => {
  const { link, state, hub, saved } = setup();
  await link.setEnabled(true);
  link.startPairing();
  const info = readPairingLink(link.snapshot().pairing.link);
  assert.equal(info.n, "测试 Mac");
  assert.equal(info.k.length, 43);
  assert.equal(info.c.length, 22);
  const phone = client(link, { name: "小杨的 iPhone" });
  const ready = await phone.connect({ pair: true });
  assert.equal(ready.mac.name, "测试 Mac");
  assert.deepEqual(phone.topics.today, state.today);
  assert.deepEqual(
    saved().devices.map((d) => d.name),
    ["小杨的 iPhone"],
  );
  assert.equal(link.snapshot().pairing.paired, "小杨的 iPhone");
  // The code is spent.
  await assert.rejects(client(link).connect({ pair: true }), /4004/);
  // Live: a change becomes a small patch the phone applies.
  state.today = { todos: [...state.today.todos, { id: "2", title: "修舵机" }] };
  hub.touch("today");
  await until(() => phone.topics.today?.todos?.length === 2);
  assert.deepEqual(phone.topics.today, state.today);
  assert.deepEqual(await phone.request("echo", { text: "你好" }), {
    back: "你好",
  });
  await assert.rejects(phone.request("delete-everything", {}), /不支持的请求/);
  const rtt = await phone.ping();
  assert(rtt < 100, `rtt ${rtt}`);
  phone.report();
  await until(() => link.snapshot().devices[0].stats);
  assert.equal(link.snapshot().devices[0].online, true);
  // Comes back later with its saved key: only what it missed.
  const key = phone.saved();
  const mac = readPairingLink(link.snapshot().pairing.link);
  const seqs = { ...phone.seqs };
  const epoch = phone.epoch;
  phone.close();
  await until(() => !link.snapshot().devices[0].online);
  state.status = { online: false };
  const again = new SyncClient({ key, mac, address: "127.0.0.1" });
  again.topics = structuredClone(phone.topics);
  again.seqs = seqs;
  again.epoch = epoch;
  const frames = [];
  again.on((m) => frames.push(m.t));
  await again.connect();
  assert.deepEqual(again.topics.status, { online: false });
  assert.deepEqual(frames, ["ready", "patch"], "a patch, not a snapshot");
  again.close();
  await link.setEnabled(false);
});

test("a wrong code, an unknown phone and a revoked one are turned away", async () => {
  const { link } = setup();
  await link.setEnabled(true);
  link.startPairing();
  const real = readPairingLink(link.snapshot().pairing.link);
  const wrong = new SyncClient({
    mac: { ...real, c: Buffer.alloc(16, 7).toString("base64url") },
    address: "127.0.0.1",
  });
  await assert.rejects(wrong.connect({ pair: true }), /4002/);
  assert.equal(link.snapshot().devices.length, 0);
  const stranger = new SyncClient({ mac: real, address: "127.0.0.1" });
  await assert.rejects(stranger.connect(), /4003/);
  // A phone that does not hold this Mac's key cannot pair either.
  const fake = new SyncClient({
    mac: { ...real, k: new SyncClient({ mac: real }).key.public },
    address: "127.0.0.1",
  });
  await assert.rejects(fake.connect({ pair: true }), /4002/);
  // Five failed tries close the pairing window.
  for (let i = 0; i < 3; i++)
    await assert.rejects(wrong.connect({ pair: true }));
  await assert.rejects(client(link).connect({ pair: true }), /4004/);
  // Pair one properly, then revoke it: it is dropped and kept out.
  link.startPairing();
  const phone = client(link);
  await phone.connect({ pair: true });
  const id = link.snapshot().devices[0].id;
  link.revoke(id);
  await until(() => phone.closed);
  assert.equal(phone.closed.code, 4003);
  const back = new SyncClient({
    key: phone.saved(),
    mac: real,
    address: "127.0.0.1",
  });
  await assert.rejects(back.connect(), /4003/);
  await link.setEnabled(false);
});

test("a tampered or replayed frame ends the connection", async () => {
  const { link } = setup();
  await link.setEnabled(true);
  link.startPairing();
  const phone = client(link);
  await phone.connect({ pair: true });
  const frame = phone.channel.seal({ t: "ping", t0: 1 });
  phone.channel.sent--;
  const bad = Buffer.from(frame);
  bad[3] ^= 1;
  phone.socket.send(bad);
  await until(() => phone.closed);
  assert.equal(phone.closed.code, 4002);
  const again = new SyncClient({
    key: phone.saved(),
    mac: readPairingLink(link.snapshot().pairing.link),
    address: "127.0.0.1",
  });
  await again.connect();
  const ping = again.channel.seal({ t: "ping", t0: 1 });
  again.socket.send(ping);
  again.socket.send(ping);
  await until(() => again.closed);
  assert.equal(again.closed.code, 4002);
  await link.setEnabled(false);
});

test("this Mac's key is made once and kept private", () => {
  const { link } = setup();
  const first = link.identity().public;
  const file = path.join(link.dir, "identity.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const { link: same } = setup({ dir: link.dir });
  assert.equal(same.identity().public, first);
});

test("updates reach the phone fast over the network stack", async () => {
  const { link, state, hub } = setup();
  await link.setEnabled(true);
  link.startPairing();
  const phone = client(link);
  await phone.connect({ pair: true });
  await phone.ping();
  for (let i = 0; i < 200; i++) {
    state.status = { online: true, tick: i };
    hub.touch("status");
    await until(() => phone.topics.status.tick === i);
  }
  const { p50, p95, n } = phone.stats();
  assert.equal(n, 200);
  // Includes the 16 ms the hub waits to merge bursts.
  assert(p95 < 60, `p50 ${p50} p95 ${p95}`);
  await link.setEnabled(false);
});

test("the Mac announces itself over Bonjour while on", async () => {
  const { link } = setup({
    bonjour: "/usr/bin/dns-sd",
    name: `t${process.pid}`,
  });
  await link.setEnabled(true);
  const found = await new Promise((resolve) => {
    const browse = spawn("/usr/bin/dns-sd", ["-B", "_otter._tcp", "local"]);
    let out = "";
    browse.stdout.on("data", (d) => {
      out += d;
      if (out.includes(`Otter · t${process.pid}`)) {
        browse.kill();
        resolve(true);
      }
    });
    setTimeout(() => {
      browse.kill();
      resolve(false);
    }, 4000);
  });
  assert.equal(found, true);
  await link.setEnabled(false);
  assert.equal(link.advert, null);
});
