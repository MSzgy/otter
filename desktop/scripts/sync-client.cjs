// A phone in Node: pairs from a link, connects, keeps every topic up to date
// by applying patches, and measures latency the way the iOS app does. The
// tests and the latency check use it; it is also the reference the Swift
// client follows.
const WebSocket = require("ws");
const {
  keyPair,
  loadKey,
  deriveKeys,
  readPairingLink,
} = require("../electron/sync-crypto.cjs");
const { apply } = require("../electron/sync-hub.cjs");

class SyncClient {
  // key: the phone's saved {public, secret}; mac: {k, a, p} from the link.
  constructor({ key = keyPair(), mac, name = "测试手机", address } = {}) {
    this.key = key.privateKey ? key : loadKey(key);
    this.mac = mac;
    this.name = name;
    this.address = address || mac.a[0];
    this.topics = {};
    this.seqs = {};
    this.epoch = null;
    this.waiting = new Map();
    this.listeners = new Set();
    this.latencies = [];
    this.offset = 0;
  }
  static fromLink(link, options = {}) {
    return new SyncClient({ ...options, mac: readPairingLink(link) });
  }
  saved() {
    return { public: this.key.public, secret: this.key.secret };
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  // Resolves once the Mac says ready and the catch-up has been applied
  // (catch-up frames are sent before anything else, in order).
  connect({ pair = false } = {}) {
    this.channel = null;
    this.closed = null;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.address}:${this.mac.p}`);
      this.socket = socket;
      const ephemeral = keyPair();
      const hello = JSON.stringify({
        t: "hello",
        v: 1,
        kind: pair ? "pair" : "resume",
        k: this.key.public,
        e: ephemeral.public,
      });
      let settled = false;
      const fail = (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      socket.on("open", () => socket.send(hello));
      socket.on("error", fail);
      socket.on("close", (code, reason) => {
        this.closed = { code, reason: String(reason) };
        fail(new Error(`closed ${code} ${reason}`));
      });
      socket.on("message", (data, binary) => {
        if (!this.channel) {
          if (binary) return fail(new Error("expected welcome"));
          const welcome = data.toString("utf8");
          this.channel = deriveKeys({
            side: "phone",
            mine: this.key,
            myEphemeral: ephemeral,
            theirs: this.mac.k,
            theirEphemeral: JSON.parse(welcome).e,
            hello,
            welcome,
            code: pair ? this.mac.c : null,
          });
          this.send({
            t: "auth",
            name: this.name,
            since: { epoch: this.epoch, seqs: this.seqs },
          });
          return;
        }
        const message = this.channel.open(data);
        this.receive(message);
        if (message.t === "ready" && !settled) {
          settled = true;
          // Let the catch-up that follows "ready" land first.
          setTimeout(() => resolve(message), 50);
        }
      });
    });
  }
  receive(message) {
    const now = Date.now();
    if (message.t === "ready") {
      this.epoch = message.epoch;
      this.control = message.device?.control !== false;
    }
    if (message.t === "device") this.control = message.control;
    if (message.t === "snap") {
      this.epoch = message.epoch;
      this.topics[message.topic] = message.value;
      this.seqs[message.topic] = message.seq;
    }
    if (message.t === "patch") {
      if (message.seq !== (this.seqs[message.topic] ?? 0) + 1) {
        this.gap = true;
        return;
      }
      this.topics[message.topic] = apply(
        this.topics[message.topic],
        message.ops,
      );
      this.seqs[message.topic] = message.seq;
      this.latencies.push(now - (message.at - this.offset));
    }
    if (message.t === "res") {
      const w = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (w)
        message.ok
          ? w.resolve(message.value)
          : w.reject(new Error(message.error));
    }
    if (message.t === "pong") {
      const rtt = now - message.t0;
      this.rtt = rtt;
      // The Mac's clock minus ours, from the middle of the round trip.
      this.offset = message.tm - (message.t0 + rtt / 2);
      this.pong?.(rtt);
    }
    for (const fn of this.listeners) fn(message);
  }
  send(message) {
    this.socket.send(this.channel.seal(message));
  }
  request(m, p) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ t: "req", id, m, p });
    });
  }
  ping() {
    return new Promise((resolve) => {
      this.pong = resolve;
      this.send({ t: "ping", t0: Date.now() });
    });
  }
  stats() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    return {
      p50: at(0.5),
      p95: at(0.95),
      n: sorted.length,
      rtt: this.rtt || 0,
    };
  }
  report() {
    this.send({ t: "stats", ...this.stats() });
  }
  close() {
    this.socket?.close();
    this.channel = null;
  }
}

module.exports = { SyncClient };
