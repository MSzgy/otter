const EVENTS = {
  coding: { caption: "我会安静陪你写代码。", action: null },
  report: { caption: "这份工作整理好啦，做得不错。", action: "wave" },
  focus: { caption: "专注结束，伸个懒腰吧。", action: "wake" },
};
class Ambient {
  constructor(saved = {}) {
    this.config = {
      enabled: false,
      cooldownMinutes: 15,
      dailyLimit: 6,
      ...saved.config,
    };
    this.state = { day: "", count: 0, lastAt: 0, ...saved.state };
  }
  configure(value) {
    if (
      typeof value.enabled !== "boolean" ||
      !Number.isInteger(value.cooldownMinutes) ||
      value.cooldownMinutes < 1 ||
      value.cooldownMinutes > 120 ||
      !Number.isInteger(value.dailyLimit) ||
      value.dailyLimit < 1 ||
      value.dailyLimit > 30
    )
      throw new Error("请设置 1–120 分钟间隔、1–30 次每日上限。");
    this.config = {
      enabled: value.enabled,
      cooldownMinutes: value.cooldownMinutes,
      dailyLimit: value.dailyLimit,
    };
    return this.snapshot();
  }
  snapshot() {
    return { config: { ...this.config }, state: { ...this.state } };
  }
  event(kind, conditions = {}, now = Date.now()) {
    if (
      !Object.hasOwn(EVENTS, kind) ||
      !this.config.enabled ||
      conditions.quiet ||
      conditions.focus ||
      conditions.busy ||
      conditions.sleeping
    )
      return null;
    const day = new Date(now).toLocaleDateString("en-CA");
    if (this.state.day !== day) this.state = { day, count: 0, lastAt: 0 };
    if (
      this.state.count >= this.config.dailyLimit ||
      now - this.state.lastAt < this.config.cooldownMinutes * 60000
    )
      return null;
    this.state.count++;
    this.state.lastAt = now;
    return { ...EVENTS[kind] };
  }
}
module.exports = { Ambient };
