// 手机: the phone link. When switched on, a WebSocket server on the local
// network (announced over Bonjour as _otter._tcp) lets paired phones follow
// the SyncHub's topics; every frame after the handshake is encrypted (see
// sync-crypto.cjs). Pairing is a QR code with this Mac's key and a one-time
// code good for five minutes. Nothing listens while it is off.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const { WebSocketServer } = require("ws");
const {
  keyPair,
  loadKey,
  deriveKeys,
  pairingLink,
  deviceId,
  b64u,
} = require("./sync-crypto.cjs");

const SERVICE = "_otter._tcp";
const PORT = 52530;
const PAIR_FOR = 5 * 60 * 1000;
const HANDSHAKE_FOR = 5000;
const IDLE_FOR = 60000;
const MAX_CONNECTIONS = 8;
const MAX_DEVICES = 10;

// The addresses a phone on the same network can reach this Mac at.
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || [])
      if (
        a.family === "IPv4" &&
        !a.internal &&
        // Link-local (169.254) and tunnels/peer links are not where a phone is.
        !a.address.startsWith("169.254.") &&
        !/^(utun|awdl|llw|bridge)/.test(name)
      )
        out.push(a.address);
  return out;
}

// The name people gave this Mac (系统设置 → 通用 → 关于本机), not its host name.
function computerName() {
  try {
    return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    return os.hostname().replace(/\.local$/, "");
  }
}

class MobileLink {
  constructor({
    hub,
    dir,
    load = () => null,
    save = () => {},
    onChange = () => {},
    requests = {},
    actions = {},
    name = computerName(),
    port = PORT,
    // Both IPv4 and IPv6: Bonjour often hands the phone an IPv6 address.
    host = "::",
    bonjour = "/usr/bin/dns-sd",
    now = Date.now,
  }) {
    this.hub = hub;
    this.dir = dir;
    this.saveState = save;
    this.onChange = onChange;
    this.requests = requests;
    // Changes a phone may ask for, only when its owner allowed it.
    this.actions = actions;
    this.name = name;
    this.preferredPort = port;
    this.host = host;
    this.bonjour = bonjour;
    this.now = now;
    const saved = load() || {};
    this.enabled = saved.enabled === true;
    this.port = Number.isInteger(saved.port) ? saved.port : port;
    this.devices = (Array.isArray(saved.devices) ? saved.devices : [])
      .filter((d) => d && typeof d.pub === "string" && typeof d.id === "string")
      .slice(0, MAX_DEVICES);
    this.connections = new Set();
    this.pairing = null;
    this.server = null;
  }
  // This Mac's own key, made once and kept in a file only this user reads.
  identity() {
    if (this.key) return this.key;
    const file = path.join(this.dir, "identity.json");
    try {
      this.key = loadKey(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      this.key = keyPair();
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        file,
        JSON.stringify({ public: this.key.public, secret: this.key.secret }),
        { mode: 0o600 },
      );
    }
    return this.key;
  }
  persist() {
    this.saveState({
      enabled: this.enabled,
      port: this.port,
      devices: this.devices,
    });
  }
  snapshot() {
    const online = new Map();
    for (const c of this.connections)
      if (c.device) online.set(c.device.id, c.stats || {});
    return {
      enabled: this.enabled,
      listening: !!this.server,
      port: this.port,
      name: this.name,
      addresses: this.server ? lanAddresses() : [],
      error: this.error || "",
      pairing: this.pairing
        ? {
            link: this.pairing.link,
            expires: this.pairing.expires,
            paired: this.pairing.paired || null,
          }
        : null,
      devices: this.devices.map((d) => ({
        id: d.id,
        name: d.name,
        control: d.control !== false,
        added: d.added,
        seen: d.seen || null,
        online: online.has(d.id),
        stats: online.get(d.id) || null,
      })),
    };
  }
  changed() {
    this.onChange(this.snapshot());
  }
  async setEnabled(on) {
    this.enabled = !!on;
    this.persist();
    if (this.enabled) await this.start();
    else this.stop();
    this.changed();
    return this.snapshot();
  }
  async start() {
    if (this.server) return;
    this.identity();
    this.error = "";
    const listen = (port) =>
      new Promise((resolve, reject) => {
        const server = new WebSocketServer({
          port,
          host: this.host,
          maxPayload: 1024 * 1024,
          perMessageDeflate: false,
        });
        server.once("listening", () => resolve(server));
        server.once("error", reject);
      });
    try {
      this.server = await listen(this.port).catch((e) =>
        e.code === "EADDRINUSE" ? listen(0) : Promise.reject(e),
      );
    } catch (e) {
      this.error = `手机连接没能开启：${e.message}`;
      this.changed();
      return;
    }
    const port = this.server.address().port;
    if (port !== this.port) {
      this.port = port;
      this.persist();
    }
    this.server.on("connection", (socket) => this.accept(socket));
    this.announce();
  }
  // Bonjour, so a paired phone finds this Mac again when its address moves.
  announce() {
    if (!this.bonjour || !fs.existsSync(this.bonjour)) return;
    this.advert = spawn(
      this.bonjour,
      [
        "-R",
        `Otter · ${this.name}`,
        SERVICE,
        "local",
        String(this.port),
        `id=${this.identity().public.slice(0, 16)}`,
      ],
      { stdio: "ignore" },
    );
    this.advert.on("error", () => {});
  }
  stop() {
    this.advert?.kill();
    this.advert = null;
    this.unlisten?.();
    this.unlisten = null;
    for (const c of this.connections) c.close(1001, "off");
    this.connections.clear();
    this.server?.close();
    this.server = null;
    this.pairing = null;
  }
  // A QR code's worth: this Mac's key, where to reach it, a one-time code.
  startPairing() {
    if (!this.server) throw new Error("请先打开“允许手机连接”。");
    if (this.devices.length >= MAX_DEVICES)
      throw new Error(`最多配对 ${MAX_DEVICES} 台手机，先撤销一台。`);
    const code = b64u(randomBytes(16));
    const info = {
      v: 1,
      n: this.name,
      k: this.identity().public,
      c: code,
      a: lanAddresses(),
      p: this.port,
      s: `Otter · ${this.name}`,
    };
    this.pairing = {
      code,
      link: pairingLink(info),
      expires: this.now() + PAIR_FOR,
      tries: 0,
    };
    this.changed();
    return this.snapshot();
  }
  cancelPairing() {
    this.pairing = null;
    this.changed();
    return this.snapshot();
  }
  // A phone that may only look, or may also act (send, confirm, stop).
  setControl(id, control) {
    const device = this.devices.find((d) => d.id === id);
    if (!device) throw new Error("没有这台手机。");
    device.control = !!control;
    for (const c of this.connections)
      if (c.device?.id === id && c.ready)
        c.send({ t: "device", control: device.control });
    this.persist();
    this.changed();
    return this.snapshot();
  }
  revoke(id) {
    this.devices = this.devices.filter((d) => d.id !== id);
    for (const c of this.connections)
      if (c.device?.id === id) c.close(4003, "revoked");
    this.persist();
    this.changed();
    return this.snapshot();
  }
  accept(socket) {
    if (this.connections.size >= MAX_CONNECTIONS) {
      socket.close(1013, "busy");
      return;
    }
    const c = new Connection(this, socket);
    this.connections.add(c);
    socket.on("close", () => {
      c.closed();
      this.connections.delete(c);
      this.follow();
      if (c.device) this.changed();
    });
  }
  // The hub only reads the app while a phone is actually following.
  follow() {
    const any = [...this.connections].some((c) => c.ready);
    if (any && !this.unlisten)
      this.unlisten = this.hub.listen((patch) => {
        for (const c of this.connections) c.push(patch);
      });
    if (!any && this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }
}

// One phone on the line: handshake, then catch-up and live patches, the
// phone's read requests, pings and its latency figures.
class Connection {
  constructor(link, socket) {
    this.link = link;
    this.socket = socket;
    this.device = null;
    this.channel = null;
    this.queue = [];
    this.ready = false;
    this.timer = setTimeout(() => this.close(4001, "slow"), HANDSHAKE_FOR);
    socket.on("message", (data, binary) => {
      try {
        if (!this.channel) this.hello(data, binary);
        else this.receive(data);
      } catch (e) {
        this.why = e.message;
        this.close(4002, "bad");
      }
    });
    socket.on("error", () => {});
  }
  closed() {
    clearTimeout(this.timer);
    clearTimeout(this.idle);
    if (this.device) {
      this.device.seen = this.link.now();
      this.link.persist();
    }
  }
  close(code, reason) {
    clearTimeout(this.timer);
    clearTimeout(this.idle);
    // OTTER_MOBILE_LOG=<file> records why connections end, for debugging.
    if (process.env.OTTER_MOBILE_LOG)
      fs.appendFileSync(
        process.env.OTTER_MOBILE_LOG,
        `${new Date().toISOString()} close ${code} ${reason} ${this.why || ""}\n`,
      );
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }
  hello(data, binary) {
    if (binary) throw new Error("expected hello");
    const text = data.toString("utf8");
    const hello = JSON.parse(text);
    if (hello.t !== "hello" || hello.v !== 1) throw new Error("not hello");
    const link = this.link;
    let code = null;
    if (hello.kind === "pair") {
      const p = link.pairing;
      if (!p || p.expires < link.now() || p.paired || p.tries >= 5)
        return this.close(4004, "pairing closed");
      p.tries++;
      code = p.code;
    } else {
      this.device = link.devices.find((d) => d.pub === hello.k) || null;
      if (!this.device) return this.close(4003, "unpaired");
    }
    const ephemeral = keyPair();
    const welcome = JSON.stringify({ t: "welcome", v: 1, e: ephemeral.public });
    this.channel = deriveKeys({
      side: "mac",
      mine: link.identity(),
      myEphemeral: ephemeral,
      theirs: hello.k,
      theirEphemeral: hello.e,
      hello: text,
      welcome,
      code,
    });
    this.pairingHello = hello.kind === "pair" ? hello : null;
    this.socket.send(welcome);
  }
  receive(data) {
    // The first sealed frame proves the keys match (and, pairing, the code).
    const message = this.channel.open(data);
    if (!this.ready)
      return void this.auth(message).catch(() => this.close(4002, "bad"));
    this.seen();
    if (message.t === "ping")
      return this.send({ t: "pong", t0: message.t0, tm: this.link.now() });
    if (message.t === "stats") {
      this.stats = {
        p50: Number(message.p50) || 0,
        p95: Number(message.p95) || 0,
        rtt: Number(message.rtt) || 0,
        n: Number(message.n) || 0,
      };
      return this.link.changed();
    }
    if (message.t === "req") return void this.request(message);
  }
  async auth(message) {
    if (message.t !== "auth") throw new Error("expected auth");
    clearTimeout(this.timer);
    const link = this.link;
    const name = String(message.name || "iPhone").slice(0, 40);
    if (this.pairingHello) {
      const pub = this.pairingHello.k;
      const id = deviceId(pub);
      link.devices = [
        ...link.devices.filter((d) => d.id !== id),
        { id, name, pub, added: link.now() },
      ];
      link.pairing.paired = name;
      this.device = link.devices.at(-1);
      link.persist();
    }
    this.ready = true;
    link.follow();
    this.seen();
    this.send({
      t: "ready",
      mac: { name: link.name, key: link.identity().public },
      device: {
        id: this.device.id,
        name: this.device.name,
        control: this.device.control !== false,
      },
      epoch: link.hub.epoch,
    });
    // Live patches wait until the catch-up is out, then skip what it covered.
    const frames = await link.hub.catchUp(message.since || {});
    const covered = {};
    for (const f of frames) {
      this.send(f);
      covered[f.topic] = f.seq;
    }
    const waiting = this.queue;
    this.queue = null;
    for (const p of waiting)
      if (!(p.seq <= (covered[p.topic] ?? 0))) this.send(p);
    link.changed();
  }
  push(patch) {
    if (!this.ready) return;
    if (this.queue) this.queue.push(patch);
    else this.send(patch);
  }
  seen() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(4008, "idle"), IDLE_FOR);
    if (this.device) this.device.seen = this.link.now();
  }
  send(message) {
    if (this.socket.readyState === 1)
      this.socket.send(this.channel.seal(message));
  }
  async request({ id, m, p }) {
    const action = Object.hasOwn(this.link.actions, m);
    const handler = action
      ? this.link.actions[m]
      : Object.hasOwn(this.link.requests, m)
        ? this.link.requests[m]
        : null;
    try {
      if (!handler) throw new Error("不支持的请求。");
      if (action && this.device.control === false)
        throw new Error(
          "这台手机只能看。要在手机上操作，请在 Mac 的 设置 → 手机 里打开“可以操作”。",
        );
      this.send({ t: "res", id, ok: true, value: await handler(p || {}) });
    } catch (e) {
      this.send({ t: "res", id, ok: false, error: e.message });
    }
  }
}

module.exports = { MobileLink, lanAddresses, SERVICE };
