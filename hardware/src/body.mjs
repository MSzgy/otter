import { validateCommand } from "./protocol.mjs";

export const LIMITS = Object.freeze({ pan: 30, tilt: 18 });
const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// 不引用浏览器或真实串口；用可注入的时钟，让断线、过期等规则能被确定性验证。
export class VirtualBody {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.connected = false;
    this.session = null;
    this.baseMood = "offline";
    this.effect = null;
    this.motion = null;
    this.pose = { pan: 0, tilt: 0 };
    this.motionEnabled = true;
    this.lastTouch = -Infinity;
    this.touchDuration = 2800;
    this.cooldown = 1200;
    this.seen = new Map();
    this.metrics = { actions: 0, touches: 0, duplicates: 0, expired: 0, rejected: 0, degraded: 0 };
  }

  connect(session) {
    this.stop();
    this.session = session;
    this.connected = true;
    this.baseMood = "idle";
    this.effect = null;
    this.seen.clear();
  }

  disconnect() {
    this.stop();
    this.connected = false;
    this.baseMood = "offline";
    this.effect = null;
  }

  configure({ touchDuration, cooldown, motionEnabled } = {}) {
    if (Number.isFinite(touchDuration)) this.touchDuration = Math.max(500, Math.min(8000, touchDuration));
    if (Number.isFinite(cooldown)) this.cooldown = Math.max(500, Math.min(5000, cooldown));
    if (typeof motionEnabled === "boolean") {
      this.motionEnabled = motionEnabled;
      if (!motionEnabled) this.stop();
    }
  }

  tick() {
    const now = this.now();
    if (this.effect && now >= this.effect.until) this.effect = null;
    if (!this.motion) return;
    const { start, duration, from, action, strength } = this.motion;
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    if (action === "nod") {
      const keyframes = [from.tilt, clamp(from.tilt + LIMITS.tilt * strength, LIMITS.tilt),
        clamp(from.tilt - LIMITS.tilt * 0.4 * strength, LIMITS.tilt), from.tilt];
      const part = Math.min(2, Math.floor(t * 3));
      this.pose.tilt = lerp(keyframes[part], keyframes[part + 1], smooth(Math.min(1, t * 3 - part)));
      this.pose.pan = from.pan;
    } else {
      const target = action === "look_left" ? -LIMITS.pan * strength : action === "look_right" ? LIMITS.pan * strength : 0;
      this.pose.pan = lerp(from.pan, target, smooth(t));
      this.pose.tilt = lerp(from.tilt, action === "center" ? 0 : from.tilt, smooth(t));
    }
    this.pose.pan = clamp(this.pose.pan, LIMITS.pan);
    this.pose.tilt = clamp(this.pose.tilt, LIMITS.tilt);
    if (t >= 1) this.motion = null;
  }

  stop() {
    this.tick();
    this.motion = null;
  }

  flash(mood = "happy", duration = this.touchDuration) {
    this.effect = { mood, until: this.now() + duration };
  }

  input(kind) {
    this.tick();
    if (kind === "long_press") {
      const sleeping = this.baseMood === "sleeping";
      this.stop();
      this.effect = null;
      this.baseMood = sleeping ? (this.connected ? "idle" : "offline") : "sleeping";
      return { accepted: true, kind, sleeping: !sleeping, local: !this.connected };
    }
    if (kind !== "touch") return { accepted: false, reason: "invalid" };
    if (this.baseMood === "sleeping") return { accepted: false, reason: "sleeping" };
    if (this.now() - this.lastTouch < this.cooldown) return { accepted: false, reason: "cooldown" };
    this.lastTouch = this.now();
    this.metrics.touches++;
    this.flash();
    return { accepted: true, kind, local: !this.connected };
  }

  receive(command) {
    this.tick();
    const reason = validateCommand(command, { now: this.now(), session: this.session, connected: this.connected });
    if (reason) {
      this.metrics[reason === "expired" ? "expired" : "rejected"]++;
      return { status: "rejected", reason, id: command?.id ?? null };
    }
    if (this.seen.has(command.id)) {
      this.metrics.duplicates++;
      return { status: "duplicate", reason: "duplicate", id: command.id, original: this.seen.get(command.id) };
    }
    let result = { status: "applied", id: command.id };
    if (command.type === "stop") {
      this.stop();
    } else if (command.type === "express") {
      const { mood, duration_ms: duration } = command.payload;
      if (mood === "happy") {
        // 休息状态不会被短暂的开心表情隐式唤醒。
        if (this.baseMood === "sleeping") result = { status: "rejected", reason: "sleeping", id: command.id };
        else this.flash(mood, duration);
      } else {
        this.baseMood = mood;
        this.effect = null;
        if (mood === "sleeping") this.stop();
      }
    } else if (this.baseMood === "sleeping") {
      result = { status: "rejected", reason: "sleeping", id: command.id };
    } else if (!this.motionEnabled) {
      this.metrics.degraded++;
      this.flash();
      result = { status: "degraded", reason: "no-motion", id: command.id };
    } else {
      this.motion = {
        action: command.payload.action, strength: command.payload.strength,
        duration: command.payload.duration_ms, start: this.now(), from: { ...this.pose },
      };
      this.metrics.actions++;
    }
    if (result.status === "rejected") this.metrics.rejected++;
    // 当前草案只保留最近 128 个 ID。真实适配器须在重试窗口内保留去重记录。
    this.seen.set(command.id, result.status);
    if (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value);
    return result;
  }

  snapshot() {
    this.tick();
    return {
      connected: this.connected, session: this.session,
      mood: this.effect?.mood || this.baseMood,
      sleeping: this.baseMood === "sleeping",
      pose: { ...this.pose }, action: this.motion?.action || null,
      motionEnabled: this.motionEnabled, metrics: { ...this.metrics },
    };
  }
}
