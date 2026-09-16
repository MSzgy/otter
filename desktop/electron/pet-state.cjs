// Pure local behavior rules. No model, network, or renderer-controlled state writes.
const ACTIONS = Object.freeze({
  pet: {
    label: "摸摸头",
    mood: "happy",
    text: ["嘿嘿，好舒服。", "再摸一下，就一下。", "把今天的好运分你一点。"],
    duration: 2800,
    cooldown: 1200,
  },
  feed: {
    label: "喂小鱼",
    mood: "eating",
    text: ["啊呜！这条小鱼真香。", "谢谢投喂，我会慢慢吃。"],
    duration: 3800,
    cooldown: 8000,
  },
  play: {
    label: "玩小球",
    mood: "playing",
    text: ["接住啦！轮到你。", "看我的小球绝技！"],
    duration: 4200,
    cooldown: 4000,
  },
  dance: {
    label: "跳个舞",
    mood: "dancing",
    text: ["给你跳一支水獭舞。", "工作间隙，晃一晃！"],
    duration: 4500,
    cooldown: 4000,
  },
  wave: {
    label: "打招呼",
    mood: "waving",
    text: ["嗨，我一直在这里。", "今天也一起慢慢来。"],
    duration: 2800,
    cooldown: 1500,
  },
  tickle: {
    label: "挠痒痒",
    mood: "tickled",
    text: ["哈哈哈，肚皮好痒！", "投降啦，给我喘口气。"],
    duration: 3000,
    cooldown: 3000,
  },
  sleep: {
    label: "睡一会儿",
    mood: "sleeping",
    text: ["抱着小石头，睡一会儿。"],
    duration: 2500,
    cooldown: 0,
  },
  wake: {
    label: "叫醒水獭",
    mood: "waking",
    text: ["伸个懒腰，我醒啦。", "早呀，又能一起玩了。"],
    duration: 3000,
    cooldown: 0,
  },
});
class PetState {
  constructor(saved = {}) {
    this.state = {
      asleep: saved?.asleep === true,
      interactions: Number.isSafeInteger(saved?.interactions)
        ? Math.max(0, Math.min(saved.interactions, 1e6))
        : 0,
      lastAction: Object.hasOwn(ACTIONS, saved?.lastAction)
        ? saved.lastAction
        : null,
      lastAt: Number.isFinite(saved?.lastAt) ? saved.lastAt : 0,
    };
    this.lastByAction = {};
    this.effect = null;
  }
  interact(action, now = Date.now()) {
    const definition = ACTIONS[action];
    if (!Object.hasOwn(ACTIONS, action)) throw new Error("不认识这个互动。");
    if (this.state.asleep && !["wake", "sleep"].includes(action))
      throw new Error("我还在睡觉，先叫醒我吧。");
    const previous =
      this.lastByAction[action] ??
      (this.state.lastAction === action ? this.state.lastAt : 0);
    if (
      previous > 0 &&
      now - previous >= 0 &&
      now - previous < definition.cooldown
    )
      throw new Error(
        action === "feed"
          ? "小鱼还没吃完，等一会儿再喂吧。"
          : "慢一点，让我玩完这一小会儿。",
      );
    if (action === "sleep" && this.state.asleep) return this.snapshot(now);
    if (action === "sleep") this.state.asleep = true;
    if (action === "wake") this.state.asleep = false;
    this.state.interactions = Math.min(1e6, this.state.interactions + 1);
    this.state.lastAction = action;
    this.state.lastAt = now;
    this.lastByAction[action] = now;
    this.effect = {
      id: `${now}-${this.state.interactions}`,
      action,
      mood: definition.mood,
      caption:
        definition.text[(this.state.interactions - 1) % definition.text.length],
      expiresAt: now + definition.duration,
    };
    return this.snapshot(now);
  }
  snapshot(now = Date.now()) {
    const effect =
      this.effect && this.effect.expiresAt > now ? this.effect : null;
    return {
      ...this.state,
      effect,
      mood: effect?.mood || (this.state.asleep ? "sleeping" : "idle"),
      caption:
        effect?.caption ||
        (this.state.asleep ? "嘘…水獭睡着了" : "点头摸摸 · 右键互动"),
    };
  }
  persisted() {
    return { ...this.state };
  }
}
module.exports = { PetState, ACTIONS };
