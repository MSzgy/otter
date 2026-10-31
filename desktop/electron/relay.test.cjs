const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { SyncHub } = require("./sync-hub.cjs");
const { MobileLink } = require("./mobile.cjs");
const { readPairingLink } = require("./sync-crypto.cjs");
const { checkRelay, deployRelay, cleanUrl, newToken } = require("./relay.cjs");
const { SshManager, SshKeychain } = require("./ssh.cjs");
const { SyncClient } = require("../scripts/sync-client.cjs");
const { startSshd } = require("../scripts/local-sshd.cjs");

// The relay built for this Mac (npm run bundle:relay), run on loopback.
const binaries = path.resolve(__dirname, "../build/relay");
const arch = process.arch === "x64" ? "amd64" : process.arch;
const binary = path.join(binaries, `otter-relay-darwin-${arch}`);
if (!fs.existsSync(binary))
  execFileSync("node", [path.resolve(__dirname, "../scripts/build_relay.cjs")]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-relay-"));
const token = newToken();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(10);
  }
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const healthy = (url) =>
  checkRelay({ url, token: "x".repeat(40) }).then(
    (r) => r.message !== undefined && !/连不上/.test(r.message),
  );

let relay, relayUrl;
test.before(async () => {
  const port = await freePort();
  relayUrl = `ws://127.0.0.1:${port}`;
  relay = spawn(binary, ["-listen", `127.0.0.1:${port}`], {
    env: { ...process.env, OTTER_RELAY_TOKEN: token },
    stdio: "ignore",
  });
  await until(() => healthy(relayUrl));
});
test.after(() => {
  relay?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  let value = { n: 0 };
  const hub = new SyncHub({
    sources: { status: () => structuredClone(value) },
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
    save: (v) => (saved = v),
  });
  return { hub, link, set: (v) => (value = v) };
}

test("relay addresses are checked", () => {
  assert.equal(cleanUrl(" ws://1.2.3.4:8787 "), "ws://1.2.3.4:8787");
  assert.equal(cleanUrl("wss://relay.example.com"), "wss://relay.example.com");
  for (const bad of [
    "http://x",
    "1.2.3.4:8787",
    "ws://x:1/path",
    "ws://x?a=1",
    "",
  ])
    assert.throws(() => cleanUrl(bad), /中继地址/, bad);
});

test("checking a relay says what is wrong", async () => {
  assert.deepEqual(await checkRelay({ url: relayUrl, token }), {
    ok: true,
    message: "中继能用。",
  });
  assert.match(
    (await checkRelay({ url: relayUrl, token: "y".repeat(40) })).message,
    /不认这个令牌/,
  );
  const closed = `ws://127.0.0.1:${await freePort()}`;
  assert.match(
    (await checkRelay({ url: closed, token })).message,
    /连不上中继/,
  );
});

test("a phone away from home comes in through the relay", async () => {
  const { hub, link, set } = setup();
  await link.setEnabled(true);
  assert.throws(
    () => link.setRelay({ url: relayUrl, token: "short" }),
    /32 个字符/,
  );
  link.setRelay({ url: relayUrl, token });
  await until(() => link.snapshot().relay?.status === "online");
  const shown = JSON.stringify(link.snapshot());
  assert(!shown.includes(token), "the token never reaches the page");
  assert.equal(
    fs.statSync(path.join(link.dir, "relay.json")).mode & 0o777,
    0o600,
  );
  link.startPairing();
  const info = readPairingLink(link.snapshot().pairing.link);
  assert.equal(info.r.u, relayUrl);
  assert.equal(info.r.i.length, 22);
  // Pairs on the local network, then comes back through the relay.
  const phone = new SyncClient({ mac: info, address: "127.0.0.1" });
  await phone.connect({ pair: true });
  phone.close();
  const away = new SyncClient({ key: phone.saved(), mac: info });
  await away.connect({ relay: true });
  assert.deepEqual(away.topics.status, { n: 0 });
  set({ n: 1 });
  hub.touch("status");
  await until(() => away.topics.status.n === 1);
  await away.ping();
  assert(away.rtt < 200, `rtt ${away.rtt}`);
  // Turned away through the relay, the phone hears why.
  link.revoke(link.snapshot().devices[0].id);
  await until(() => away.closed);
  assert.equal(away.closed.code, 4003);
  // With Otter's link off, the relay says the Mac is not there.
  await link.setEnabled(false);
  const late = new SyncClient({ key: phone.saved(), mac: info });
  await assert.rejects(late.connect({ relay: true }), /4404/);
});

test("phones hear when the relay changes; a wrong token stays offline", async () => {
  const { link } = setup();
  await link.setEnabled(true);
  link.startPairing();
  const phone = SyncClient.fromLink(link.snapshot().pairing.link, {
    address: "127.0.0.1",
  });
  await phone.connect({ pair: true });
  assert.equal(phone.mac.r, undefined);
  link.setRelay({ url: relayUrl, token });
  await until(() => phone.mac.r?.u === relayUrl);
  const room = phone.mac.r.i;
  // The room stays when the address or token is changed.
  link.setRelay({ url: relayUrl, token: newToken() });
  await until(() => link.snapshot().relay?.status === "offline");
  assert.match(link.snapshot().relay.error, /不认这个令牌/);
  assert.equal(link.relayInfo().i, room);
  link.clearRelay();
  await until(() => phone.mac.r === undefined);
  assert.equal(link.snapshot().relay, null);
  phone.close();
  await link.setEnabled(false);
});

test("the Mac finds the relay again after it restarts", async () => {
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const run = () =>
    spawn(binary, ["-listen", `127.0.0.1:${port}`], {
      env: { ...process.env, OTTER_RELAY_TOKEN: token },
      stdio: "ignore",
    });
  let server = run();
  await until(() => healthy(url));
  const { link } = setup();
  await link.setEnabled(true);
  link.setRelay({ url, token });
  await until(() => link.snapshot().relay?.status === "online");
  server.kill();
  await until(() => link.snapshot().relay?.status === "offline");
  server = run();
  await until(() => link.snapshot().relay?.status === "online", 8000);
  link.startPairing();
  const info = readPairingLink(link.snapshot().pairing.link);
  const phone = new SyncClient({ mac: info });
  await phone.connect({ pair: true, relay: true });
  assert.equal(link.snapshot().devices.length, 1, "paired through the relay");
  phone.close();
  await link.setEnabled(false);
  server.kill();
});

test("deploying to a server over SSH starts a working relay", async () => {
  const sshd = await startSshd();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "otter-relay-ssh-"));
  const keychain = path.join(
    os.tmpdir(),
    `otter-relay-${process.pid}.keychain-db`,
  );
  let servers = null;
  const ssh = new SshManager({
    load: () => servers,
    save: (v) => (servers = v),
    dir: path.join(home, "ssh"),
    home,
    keychain: new SshKeychain({ keychain }),
  });
  const target = path.join(home, "server");
  try {
    await ssh.saveHost({
      name: "local",
      host: "127.0.0.1",
      port: sshd.port,
      user: sshd.user,
      auth: "key",
      keyPath: sshd.key,
    });
    const port = await freePort();
    const result = await deployRelay({
      ssh,
      server: "local",
      port,
      binaries,
      dir: target,
    });
    assert.equal(result.reachable, true, result.message);
    assert.equal(result.how, "nohup");
    assert.equal(result.url, `ws://127.0.0.1:${port}`);
    assert.equal(result.token.length, 43);
    assert.equal(fs.statSync(path.join(target, "token")).mode & 0o777, 0o600);
    assert.deepEqual(
      await checkRelay({ url: result.url, token: result.token }),
      {
        ok: true,
        message: "中继能用。",
      },
    );
    // Deploying again replaces the running one.
    const again = await deployRelay({
      ssh,
      server: "local",
      port,
      binaries,
      dir: target,
    });
    assert.equal(again.reachable, true);
    assert.match(
      (await checkRelay({ url: again.url, token: result.token })).message,
      /不认这个令牌/,
    );
  } finally {
    try {
      execFileSync("/usr/bin/pkill", ["-f", path.join(target, "otter-relay")]);
    } catch {
      // already gone
    }
    sshd.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
