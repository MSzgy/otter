// 这是一份模拟协议草案。真实 ESP32 接入前，还需要实现时钟同步与串口帧解析。
export const VERSION = 1;
export const MOODS = Object.freeze(["idle", "listening", "thinking", "speaking", "happy", "sleeping", "offline"]);
export const ACTIONS = Object.freeze(["nod", "look_left", "look_right", "center"]);
export const MOOD_LABELS = Object.freeze({
  idle: "陪伴中", listening: "认真听", thinking: "想一想",
  speaking: "说话中", happy: "好开心", sleeping: "休息中", offline: "离线待机",
});
export const ACTION_LABELS = Object.freeze({
  nod: "点点头", look_left: "向左看", look_right: "向右看", center: "回正",
});
export const REASON_LABELS = Object.freeze({
  invalid: "指令格式不正确", version: "协议版本不匹配", session: "这是上一次连接的指令",
  expired: "指令已过期", disconnected: "模拟设备已断开", sleeping: "正在休息，先叫醒它",
  duplicate: "同一条指令只执行一次", "no-motion": "只有屏幕，已改用表情回应",
  cooldown: "刚摸过头，让它缓一小会儿",
});

const token = (value) => typeof value === "string" && /^[\w-]{1,80}$/.test(value);
const numberBetween = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

export function validateCommand(command, { now, session, connected }) {
  if (!command || typeof command !== "object" || Array.isArray(command)) return "invalid";
  if (command.v !== VERSION) return "version";
  if (!token(command.id) || !token(command.session)) return "invalid";
  if (!connected) return "disconnected";
  if (command.session !== session) return "session";
  if (!Number.isFinite(command.expires_at_ms)) return "invalid";
  if (command.expires_at_ms <= now) return "expired";
  if (command.expires_at_ms - now > 30_000) return "invalid";
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "invalid";
  if (command.type === "express") {
    if (!MOODS.includes(payload.mood) || payload.mood === "offline") return "invalid";
    if (!numberBetween(payload.duration_ms, 500, 8000)) return "invalid";
  } else if (command.type === "perform") {
    if (!ACTIONS.includes(payload.action)) return "invalid";
    if (!numberBetween(payload.duration_ms, 600, 2500)) return "invalid";
    if (!numberBetween(payload.strength, 0.1, 1)) return "invalid";
  } else if (command.type !== "stop") {
    return "invalid";
  }
  return null;
}

export function makeCommand({ id, session, type, payload = {}, now, ttl = 2000 }) {
  return { v: VERSION, session, id, type, expires_at_ms: now + ttl, payload: { ...payload } };
}
