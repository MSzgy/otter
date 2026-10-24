// The physical otter: mirrors the desktop state to an ESP32 "body" over USB serial.
// Hardware is optional. Nothing here may throw into the app or slow it down: the
// bridge is off by default, every device operation is fire-and-forget, and a
// missing serial library, missing board or dropped cable only changes status().
// Only expression names, voice line names and a chirp ever go to the device;
// never chat text, reminder titles or memories.
const { EventEmitter } = require("node:events");

const DEVICE_VID = "303a"; // Espressif USB Serial/JTAG on the ESP32-S3
const FIRMWARE_PREFIX = "otter-face-";
const RETRY_MS = [2000, 5000, 10000];
const REPLY_MS = 3000;
// The firmware without the pixel pack only knows these.
const DRAWN_FACES = ["idle", "happy", "sleeping", "thinking", "speaking"];
// Voice line rules from the pack (hardware/assets/pixel_game/voice/manifest.json;
// a test keeps them in sync). A line plays once when its state is entered. These
// never play by themselves: idle, focus and speaking are manual only, and
// listening must come before the microphone opens, which this bridge does not see.
const VOICE_NEVER_AUTO = ["idle", "focus", "speaking", "listening"];
const VOICE_COOLDOWN_MS = 5000;
const TAP_SAID_MS = 3000; // the board says 嘿嘿 itself when its screen is tapped

// Desktop state -> one expression name, highest priority first. Follows the
// desktop pet's own order (speaking > pet effect > asleep > busy > idle) and
// splits "busy" into thinking (chat) and working (report job).
function resolveExpression(s, now = Date.now()) {
  if (s.speaking) return "speaking";
  if (s.pet?.effect && s.pet.effect.expiresAt > now) return s.pet.effect.mood;
  if (s.dueReminders > 0) return "reminder";
  if (s.pet?.asleep) return "sleeping";
  if (s.connection === "offline") return "offline";
  if (s.chatStatus === "streaming") return "thinking";
  if (s.online && ["queued", "running"].includes(s.jobStatus)) return "working";
  if (s.focus) return "focus";
  return "idle";
}

class BodyBridge extends EventEmitter {
  constructor({
    serial,
    schedule = setTimeout,
    cancel = clearTimeout,
    now = Date.now,
    log = () => {},
  }) {
    super();
    this.serial = serial; // { available(), list(), open(path) } from body-serial.cjs
    this.schedule = schedule;
    this.cancel = cancel;
    this.now = now;
    this.log = log;
    this.enabled = false;
    this.status = "off";
    this.message = "";
    this.device = null; // { path, firmware, skin }
    this.port = null;
    this.faces = new Set();
    this.voices = new Set(); // voice lines the device can play
    this.lastSaid = new Map(); // expression -> when its line last played
    this.lastTapAt = -Infinity;
    this.sent = null; // last expression sent to the device
    this.attempt = 0;
    this.timer = null;
    this.pending = null; // { match, resolve, timer } while waiting for a reply line
    this.seenDue = new Set();
    this.state = {
      connection: "connecting",
      online: false,
      chatStatus: null,
      jobStatus: null,
      speaking: false,
      pet: null,
      dueReminders: 0,
      focus: false,
      quiet: false,
    };
  }

  snapshot() {
    return {
      enabled: this.enabled,
      status: this.status,
      message: this.message,
      device: this.device,
      expression: resolveExpression(this.state, this.now()),
    };
  }

  configure({ enabled }) {
    enabled = enabled === true;
    if (enabled === this.enabled) return this.snapshot();
    this.enabled = enabled;
    if (enabled) {
      this.attempt = 0;
      this.setStatus("searching", "正在寻找实体水獭…");
      this.connectSoon(0);
    } else {
      this.disconnect();
      this.setStatus("off", "");
    }
    return this.snapshot();
  }

  stop() {
    this.enabled = false;
    this.disconnect();
  }

  // App events in; safe to call at any time, with or without a device.
  observe(event) {
    try {
      if (!event || typeof event.type !== "string") return;
      const s = this.state,
        d = event.data || {};
      if (event.type === "connection") {
        s.connection = d.status;
        s.online = d.status === "online";
        if (!s.online) s.chatStatus = null;
      } else if (
        event.type === "chat.activity" ||
        event.type === "chat.changed"
      ) {
        s.chatStatus = d.status || null;
      } else if (event.type === "job.changed") {
        s.jobStatus = d.status || null;
      } else if (event.type === "voice.activity") {
        s.speaking = !!d.speaking;
      } else if (event.type === "pet.changed") {
        const effect = d.effect
          ? { mood: d.effect.mood, expiresAt: d.effect.expiresAt }
          : null;
        s.pet = { asleep: !!d.asleep, effect };
      } else if (event.type === "assistant.changed") {
        const due = (d.reminders || []).filter((r) => r.status === "due");
        s.dueReminders = due.length;
        s.focus = !!d.focus;
        const fresh = due.some((r) => !this.seenDue.has(r.id));
        this.seenDue = new Set(due.map((r) => r.id));
        if (fresh && !s.quiet && !this.say("reminder"))
          this.send("SOUND chirp");
      } else if (event.type === "preferences") {
        s.quiet = !!d.quiet;
      } else {
        return;
      }
      this.sync();
    } catch (error) {
      this.log("body observe failed", error);
    }
  }

  sync() {
    if (this.status !== "connected") return;
    let face = resolveExpression(this.state, this.now());
    if (!this.faces.has(face)) face = "idle";
    if (face === this.sent) return;
    // The first face after (re)connecting only catches up; it is not an entry.
    const entered = this.sent !== null;
    this.sent = face;
    this.send(`FACE ${face}`);
    if (!entered || !this.voices.size) return;
    if (face === "speaking")
      this.send("SAY STOP"); // the Mac reads aloud; don't talk over it
    else this.say(face);
  }

  // Plays an expression's voice line if the pack's rules allow it now.
  say(face) {
    const s = this.state,
      now = this.now();
    if (this.status !== "connected" || !this.voices.has(face) || s.quiet)
      return false;
    if (VOICE_NEVER_AUTO.includes(face)) return false;
    if (s.focus && face !== "reminder") return false;
    if (face === "happy" && now - this.lastTapAt < TAP_SAID_MS) return false;
    if (now - (this.lastSaid.get(face) ?? -Infinity) < VOICE_COOLDOWN_MS)
      return false;
    this.lastSaid.set(face, now);
    this.send(`SAY ${face}`);
    return true;
  }

  send(line) {
    if (this.status !== "connected" || !this.port) return;
    try {
      this.port.write(line);
    } catch (error) {
      this.log("body write failed", error);
    }
  }

  setStatus(status, message) {
    this.status = status;
    this.message = message;
    try {
      this.emit("changed", this.snapshot());
    } catch (error) {
      this.log("body status listener failed", error);
    }
  }

  connectSoon(delay) {
    this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = null;
      this.connect().catch((error) => this.retry(`连接失败：${error.message}`));
    }, delay);
  }

  retry(message) {
    this.disconnect();
    if (!this.enabled) return;
    this.setStatus("searching", message);
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt++;
    this.connectSoon(delay);
  }

  async connect() {
    if (!this.enabled) return;
    if (!this.serial.available()) {
      this.setStatus(
        "unavailable",
        "串口组件不可用，实体水獭已停用；桌面功能不受影响。",
      );
      return;
    }
    const ports = (await this.serial.list()).filter(
      (p) => String(p.vendorId || "").toLowerCase() === DEVICE_VID,
    );
    if (!this.enabled) return;
    if (ports.length === 0)
      return this.retry("没有找到实体水獭，插上 USB 后会自动连接。");
    // tty.* can block on open waiting for carrier detect; cu.* does not.
    const path = ports[0].path.replace("/dev/tty.", "/dev/cu.");
    let port = null;
    port = await this.serial.open(path, {
      onLine: (line) => this.onLine(line),
      onClose: () => {
        if (port && this.port === port) this.retry("实体水獭已断开，正在重试…");
      },
    });
    if (!this.enabled) return port.close();
    this.port = port;
    this.status = "handshake";
    port.write("INFO");
    const info = JSON.parse(
      await this.expect((l) => l.startsWith('{"firmware":')),
    );
    if (!String(info.firmware).startsWith(FIRMWARE_PREFIX))
      return this.retry(`设备不是 Otter 固件（${info.firmware}）。`);
    let faces = DRAWN_FACES;
    if (info.skin && info.skin !== "drawn") {
      // Only firmware that reports a pixel pack (0.5.0+) knows FACE LIST.
      port.write("FACE LIST");
      faces = JSON.parse(
        await this.expect((l) => l.startsWith('{"faces":')),
      ).faces;
    }
    this.faces = new Set(faces);
    let voices = [];
    if (info.voices > 0) {
      // Firmware 0.6.0+ reports its voice pack in INFO and lists it with SAY LIST.
      port.write("SAY LIST");
      voices = JSON.parse(
        await this.expect((l) => l.startsWith('{"voices":')),
      ).voices;
    }
    this.voices = new Set(voices);
    this.device = {
      path,
      firmware: info.firmware,
      skin: info.skin || "drawn",
      voices: voices.length,
    };
    this.attempt = 0;
    this.sent = null;
    this.setStatus("connected", `已连接 ${info.firmware}`);
    this.sync();
  }

  expect(match) {
    return new Promise((resolve, reject) => {
      const timer = this.schedule(() => {
        this.pending = null;
        reject(new Error("设备没有回应"));
      }, REPLY_MS);
      this.pending = { match, resolve, timer };
    });
  }

  onLine(line) {
    if (this.pending?.match(line)) {
      const { resolve, timer } = this.pending;
      this.pending = null;
      this.cancel(timer);
      return resolve(line);
    }
    if (this.status !== "connected") return;
    if (/^EVENT screen_touch \d+$/.test(line)) {
      this.lastTapAt = this.now();
      try {
        this.emit("tap");
      } catch (error) {
        this.log("body tap handler failed", error);
      }
    } else if (line.startsWith("ERR ")) this.log("body device error", line);
  }

  disconnect() {
    this.cancel(this.timer);
    this.timer = null;
    if (this.pending) {
      this.cancel(this.pending.timer);
      this.pending = null;
    }
    const port = this.port;
    this.port = null;
    this.device = null;
    this.sent = null;
    if (port)
      try {
        port.close();
      } catch {}
  }
}

module.exports = {
  BodyBridge,
  resolveExpression,
  DEVICE_VID,
  VOICE_NEVER_AUTO,
  VOICE_COOLDOWN_MS,
};
