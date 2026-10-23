import { VirtualBody } from "./body.mjs";
import { makeCommand, MOOD_LABELS, ACTION_LABELS, REASON_LABELS } from "./protocol.mjs";

export class HardwareLab {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.sessionCounter = 0;
    this.commandCounter = 0;
    this.logCounter = 0;
    this.revision = 0;
    this.settings = { latency: 80, nodDuration: 1400, strength: 0.65, touchDuration: 2800 };
    this.logs = [];
    this.queue = [];
    this.routine = [];
    this.body = new VirtualBody(now);
    this.latestNotice = "准备好了，摸摸我的头吧。";
    this.lesson = { touch: false, sent: false, moved: false, returned: false };
    this.touchStartedAt = null;
    this.connect();
  }

  record(direction, title, detail = "", packet = null) {
    this.logs.push({ key: ++this.logCounter, at: this.now(), direction, title, detail, packet });
    if (this.logs.length > 120) this.logs.shift();
    this.revision++;
  }

  connect() {
    this.queue = [];
    this.routine = [];
    this.body.connect(`sim-${++this.sessionCounter}-${Math.round(this.now()).toString(36)}`);
    this.record("system", "模拟设备已连接", "开启新会话；不会重放旧动作。");
    this.latestNotice = "准备好了，摸摸我的头吧。";
  }

  disconnect() {
    const count = this.queue.length;
    this.queue = [];
    this.routine = [];
    this.body.disconnect();
    this.record("system", "模拟连接已断开", `停止运动，清除 ${count} 条待发送指令。摸头仍可在本地回应。`);
    this.latestNotice = "已离线。摸头仍有本地回应，Mac 指令暂停。";
  }

  interrupt() {
    if (this.routine.length) {
      this.routine = [];
      this.record("system", "演示已暂停", "你的操作优先。");
    }
  }

  send(type, payload, { delay = this.settings.latency, ttl = 2000, packet = null } = {}) {
    if (!this.body.connected) {
      this.latestNotice = REASON_LABELS.disconnected;
      this.record("blocked", "未发送", this.latestNotice);
      return null;
    }
    if (this.queue.length >= 32) {
      this.latestNotice = "等待中的指令太多，先让水獭完成这一轮。";
      this.record("blocked", "发送队列已满", "最多保留 32 条待发送指令。");
      return null;
    }
    const command = packet || makeCommand({
      id: `cmd-${++this.commandCounter}`, session: this.body.session, type, payload, now: this.now(), ttl,
    });
    this.queue.push({ command: structuredClone(command), due: this.now() + Math.max(0, delay) });
    this.record("out", type === "express" ? `请求表情：${MOOD_LABELS[payload.mood] || payload.mood}`
      : type === "stop" ? "请求停止" : `请求动作：${ACTION_LABELS[payload.action] || payload.action}`,
    delay ? `模拟传输等待 ${delay} 毫秒。` : "立即传输。", command);
    this.pump();
    return command;
  }

  express(mood) {
    return this.send("express", { mood, duration_ms: this.settings.touchDuration });
  }

  perform(action, options) {
    return this.send("perform", { action, duration_ms: this.settings.nodDuration, strength: this.settings.strength }, options);
  }

  input(kind) {
    this.interrupt();
    const result = this.body.input(kind);
    if (!result.accepted) {
      this.latestNotice = REASON_LABELS[result.reason] || "暂时无法互动";
      this.record("blocked", "触摸未触发", this.latestNotice);
      return result;
    }
    if (kind === "long_press") {
      // 长按休息时取消排队动作，避免随后收到旧的点头请求。
      this.queue = [];
      this.latestNotice = result.sleeping ? "休息一下。再长按一秒就醒来。" : "我醒啦！";
      this.record(result.local ? "local" : "in", result.sleeping ? "长按 → 进入休息" : "长按 → 唤醒", "触摸行为在设备本地处理。");
      return result;
    }
    this.lesson = { touch: true, sent: false, moved: false, returned: false };
    this.touchStartedAt = this.now();
    this.latestNotice = result.local ? "摸头已在本地回应；离线时不发送给 Mac。" : "收到摸头啦，先眯眼，再点点头。";
    this.record(result.local ? "local" : "in", "摸头 → 立即眯眼", result.local ? "只在模拟设备本地处理。" : "设备向 Mac 上报 touch 事件。",
      { v: 1, type: "input", session: this.body.session, payload: { kind: "touch" } });
    if (!result.local) {
      this.lesson.sent = true;
      this.perform("nod", { delay: Math.max(180, this.settings.latency) });
    }
    return result;
  }

  handleResult(command, result) {
    const ok = result.status === "applied";
    const description = REASON_LABELS[result.reason] || (command.type === "perform"
      ? `${ACTION_LABELS[command.payload.action]}开始执行。` : "模拟设备已确认。");
    const title = ok ? "设备已确认" : result.status === "degraded" ? "改用表情回应"
      : result.status === "duplicate" ? "拦截重复指令" : "指令未执行";
    this.record(ok ? "ack" : result.status === "degraded" ? "local" : "blocked",
      title, description, { v: 1, type: "ack", session: this.body.session, ...result });
    if (command.type === "perform" && (ok || result.status === "degraded") && this.lesson.sent) this.lesson.moved = true;
    if (!ok) this.latestNotice = description;
  }

  pump() {
    const now = this.now();
    const ready = this.queue.filter((entry) => entry.due <= now);
    this.queue = this.queue.filter((entry) => entry.due > now);
    for (const { command } of ready) this.handleResult(command, this.body.receive(command));
    const steps = this.routine.filter((step) => step.at <= now);
    this.routine = this.routine.filter((step) => step.at > now);
    for (const step of steps) {
      // 浏览器从后台回来时不补播过时的演示。
      if (now - step.at > 2000) continue;
      if (step.action) this.perform(step.action);
      else this.express(step.mood);
    }
    this.body.tick();
    if (this.touchStartedAt !== null && this.lesson.moved && !this.body.motion && !this.body.effect) {
      this.lesson.returned = true;
      this.touchStartedAt = null;
    }
  }

  stop() {
    this.queue = [];
    this.routine = [];
    this.body.stop();
    this.latestNotice = "动作已停止，保持当前姿态。";
    this.record("system", "停止所有动作", "清除等待中的动作；当前角度保持不变。");
  }

  conversation() {
    if (!this.body.connected) return;
    this.stop();
    this.latestNotice = "这是预设对话演示，没有调用模型或麦克风。";
    this.express("listening");
    const now = this.now();
    this.routine = [
      { at: now + 1100, mood: "thinking" },
      { at: now + 2700, mood: "speaking" },
      { at: now + 3300, action: "nod" },
      { at: now + 4800, mood: "idle" },
      { at: now + 4850, mood: "happy" },
    ];
    this.record("system", "开始对话演示", "认真听 → 想一想 → 说话 → 点头 → 开心。");
  }

  fault(kind) {
    this.interrupt();
    if (!this.body.connected) {
      this.latestNotice = "先连接模拟设备，再开始演练。";
      return;
    }
    if (kind === "duplicate") {
      const packet = this.perform("nod");
      if (packet) this.send("perform", packet.payload, { packet, delay: this.settings.latency + 50 });
      this.latestNotice = "已发送两份相同指令，观察是否只点一次头。";
    } else if (kind === "expired") {
      this.perform("nod", { delay: 1400, ttl: 500 });
      this.latestNotice = "动作只在 0.5 秒内有效，故意延迟 1.4 秒送达。";
    } else if (kind === "reconnect") {
      const old = this.perform("nod", { delay: 1500, ttl: 2000 });
      this.disconnect();
      this.connect();
      // 显式注入旧会话帧，验证接收端也会拒绝，而不只依赖清空主机队列。
      if (old) this.handleResult(old, this.body.receive(old));
      this.latestNotice = "已重新连接：等待中的动作已清除，旧会话指令也被拒绝。";
    }
  }

  configure(settings) {
    const ranges = { latency: [0, 2000], nodDuration: [600, 2500], strength: [0.1, 1], touchDuration: [500, 8000] };
    for (const [name, range] of Object.entries(ranges)) {
      if (Number.isFinite(settings[name])) this.settings[name] = Math.min(range[1], Math.max(range[0], settings[name]));
    }
    this.body.configure({ touchDuration: this.settings.touchDuration, motionEnabled: settings.motionEnabled });
    this.revision++;
  }

  snapshot() {
    this.pump();
    return { ...this.body.snapshot(), settings: { ...this.settings }, pending: this.queue.length,
      notice: this.latestNotice, lesson: { ...this.lesson }, revision: this.revision, routine: this.routine.length > 0 };
  }

  exportTrace() {
    return {
      application: "Otter Hardware Lab", version: "0.1.0", simulation: true,
      exported_at: new Date(this.now()).toISOString(), settings: { ...this.settings },
      device: this.body.snapshot(), events: structuredClone(this.logs),
    };
  }
}
