import test from "node:test";
import assert from "node:assert/strict";
import { HardwareLab } from "../src/lab.mjs";
import { VirtualBody, LIMITS } from "../src/body.mjs";
import { makeCommand } from "../src/protocol.mjs";

function setup() {
  let time = 1_000_000;
  const lab = new HardwareLab({ now: () => time });
  const advance = (ms) => { time += ms; return lab.snapshot(); };
  return { lab, advance, now: () => time };
}

test("摸头立即在本地眯眼，延后点头，最后恢复原状态", () => {
  const { lab, advance } = setup();
  lab.input("touch");
  assert.equal(lab.snapshot().mood, "happy");
  assert.equal(lab.snapshot().metrics.actions, 0);
  advance(180);
  assert.equal(lab.snapshot().action, "nod");
  advance(300);
  assert.ok(lab.snapshot().pose.tilt > 0);
  advance(2400);
  assert.equal(lab.snapshot().action, null);
  assert.equal(lab.snapshot().mood, "idle");
  assert.equal(lab.snapshot().pose.tilt, 0);
  assert.deepEqual(lab.snapshot().lesson, { touch: true, sent: true, moved: true, returned: true });
});

test("冷却期间重复摸头不会再派发动作；边界之后恢复", () => {
  const { lab, advance } = setup();
  assert.equal(lab.input("touch").accepted, true);
  advance(100);
  assert.equal(lab.input("touch").reason, "cooldown");
  assert.equal(lab.queue.length, 1);
  advance(1100);
  assert.equal(lab.input("touch").accepted, true);
  assert.equal(lab.snapshot().metrics.touches, 2);
});

test("同一 ID 发送两遍，只执行一个动作", () => {
  const { lab, advance } = setup();
  lab.fault("duplicate");
  advance(200);
  assert.equal(lab.snapshot().metrics.actions, 1);
  assert.equal(lab.snapshot().metrics.duplicates, 1);
});

test("过期指令不会驱动动作，日志记录拒绝原因", () => {
  const { lab, advance } = setup();
  lab.fault("expired");
  advance(1400);
  assert.equal(lab.snapshot().metrics.actions, 0);
  assert.equal(lab.snapshot().metrics.expired, 1);
  assert.ok(lab.logs.some((item) => item.packet?.reason === "expired"));
});

test("断开后立即停止，等待中的指令清除，重连不补执行", () => {
  const { lab, advance } = setup();
  lab.perform("nod");
  advance(100);
  advance(300);
  const pose = lab.snapshot().pose;
  assert.ok(pose.tilt > 0);
  lab.perform("look_left", { delay: 700 });
  lab.disconnect();
  advance(500);
  assert.equal(lab.snapshot().action, null);
  assert.deepEqual(lab.snapshot().pose, pose);
  assert.equal(lab.queue.length, 0);
  lab.connect();
  advance(1000);
  assert.equal(lab.snapshot().metrics.actions, 1);
  assert.deepEqual(lab.snapshot().pose, pose);
});

test("重连后接收端拒绝上一会话的有效期内指令", () => {
  const { lab, now } = setup();
  const old = makeCommand({ id: "old-1", session: lab.body.session, type: "stop", now: now() });
  lab.disconnect();
  lab.connect();
  assert.equal(lab.body.receive(old).reason, "session");
});

test("断线重连演练清空主机队列，并验证接收端旧会话拦截", () => {
  const { lab, advance } = setup();
  lab.fault("reconnect");
  advance(2000);
  assert.equal(lab.snapshot().connected, true);
  assert.equal(lab.snapshot().metrics.actions, 0);
  assert.ok(lab.logs.some((entry) => entry.packet?.reason === "session"));
});

test("离线摸头只产生本地表情，不会积压 Mac 指令", () => {
  const { lab, advance } = setup();
  lab.disconnect();
  lab.input("touch");
  assert.equal(lab.snapshot().mood, "happy");
  assert.equal(lab.queue.length, 0);
  assert.equal(lab.snapshot().lesson.sent, false);
  advance(3000);
  assert.equal(lab.snapshot().mood, "offline");
  assert.equal(lab.snapshot().metrics.actions, 0);
});

test("长按休息取消尚未执行的摸头动作；再次长按可唤醒", () => {
  const { lab, advance } = setup();
  lab.input("touch");
  lab.input("long_press");
  advance(300);
  assert.equal(lab.snapshot().mood, "sleeping");
  assert.equal(lab.snapshot().metrics.actions, 0);
  assert.equal(lab.input("touch").reason, "sleeping");
  lab.input("long_press");
  assert.equal(lab.snapshot().mood, "idle");
});

test("睡眠状态拒绝运动和短暂开心表情，明确 idle 才唤醒", () => {
  const { lab, advance } = setup();
  lab.express("sleeping");
  advance(100);
  lab.perform("nod");
  lab.express("happy");
  advance(100);
  assert.equal(lab.snapshot().mood, "sleeping");
  assert.equal(lab.snapshot().metrics.actions, 0);
  assert.equal(lab.snapshot().metrics.rejected, 2);
  lab.express("idle");
  advance(100);
  assert.equal(lab.snapshot().mood, "idle");
});

test("只有屏幕时用表情回应，教学步骤仍能完成", () => {
  const { lab, advance } = setup();
  lab.configure({ motionEnabled: false });
  lab.input("touch");
  advance(200);
  assert.equal(lab.snapshot().metrics.actions, 0);
  assert.equal(lab.snapshot().metrics.degraded, 1);
  assert.equal(lab.snapshot().mood, "happy");
  advance(3000);
  assert.equal(lab.snapshot().lesson.returned, true);
});

test("停止动作保留当前姿态，回正命令能从此姿态平滑恢复", () => {
  const { lab, advance } = setup();
  lab.perform("look_right");
  advance(100);
  advance(500);
  lab.stop();
  const position = lab.snapshot().pose.pan;
  assert.ok(position > 0);
  advance(5000);
  assert.equal(lab.snapshot().pose.pan, position);
  lab.perform("center");
  advance(100);
  assert.ok(lab.snapshot().pose.pan <= position);
  advance(2000);
  assert.deepEqual(lab.snapshot().pose, { pan: 0, tilt: 0 });
});

test("连续动作从当前姿态开始；整个轨迹不超过模拟限位", () => {
  const { lab, advance } = setup();
  lab.configure({ strength: 1, latency: 0 });
  for (const action of ["look_left", "look_right", "nod", "center"]) {
    lab.perform(action);
    for (let i = 0; i < 90; i++) {
      const state = advance(20);
      assert.ok(Math.abs(state.pose.pan) <= LIMITS.pan);
      assert.ok(Math.abs(state.pose.tilt) <= LIMITS.tilt);
    }
  }
  assert.deepEqual(lab.snapshot().pose, { pan: 0, tilt: 0 });
});

test("缺少会话、非法角度参数、NaN、未知动作等输入全部拒绝", () => {
  let now = 1000;
  const body = new VirtualBody(() => now);
  body.connect("session-1");
  const base = makeCommand({
    id: "valid", session: "session-1", now, type: "perform",
    payload: { action: "nod", duration_ms: 1200, strength: 0.6 },
  });
  const bad = [
    null, [], {}, { ...base, v: 2 }, { ...base, session: null },
    { ...base, expires_at_ms: NaN }, { ...base, expires_at_ms: now },
    { ...base, expires_at_ms: now + 999999 }, { ...base, id: "<script>" },
    { ...base, payload: { ...base.payload, action: "arbitrary_motor" } },
    { ...base, payload: { ...base.payload, strength: 3 } },
    { ...base, payload: { ...base.payload, duration_ms: -10 } },
    { ...base, payload: { ...base.payload, strength: NaN } },
  ];
  for (const packet of bad) assert.equal(body.receive(packet).status, "rejected");
  assert.equal(body.snapshot().metrics.actions, 0);
  now += 100;
  assert.equal(body.receive(base).status, "applied");
});

test("同一 ID 改变内容也不会再执行", () => {
  const { lab, advance } = setup();
  const packet = lab.perform("look_left");
  advance(100);
  const result = lab.body.receive({ ...packet, payload: { ...packet.payload, action: "look_right" } });
  assert.equal(result.status, "duplicate");
  assert.equal(lab.snapshot().metrics.actions, 1);
});

test("参数被限制到合理范围，传输队列和日志都有上限", () => {
  const { lab } = setup();
  lab.configure({ latency: 99999, strength: -10, touchDuration: NaN });
  assert.equal(lab.settings.latency, 2000);
  assert.equal(lab.settings.strength, 0.1);
  assert.equal(lab.settings.touchDuration, 2800);
  for (let i = 0; i < 160; i++) lab.perform("nod");
  assert.equal(lab.queue.length, 32);
  assert.equal(lab.logs.length, 120);
});

test("对话演示按状态推进，用户操作可取消后续演示", () => {
  const { lab, advance } = setup();
  lab.conversation();
  advance(100);
  assert.equal(lab.snapshot().mood, "listening");
  advance(1000);
  advance(100);
  assert.equal(lab.snapshot().mood, "thinking");
  lab.input("long_press");
  advance(6000);
  assert.equal(lab.snapshot().mood, "sleeping");
  assert.equal(lab.routine.length, 0);
  assert.equal(lab.snapshot().metrics.actions, 0);
});

test("导出的演练记录明确标记模拟，返回独立副本", () => {
  const { lab } = setup();
  lab.input("touch");
  const result = lab.exportTrace();
  assert.equal(result.simulation, true);
  result.events.length = 0;
  assert.ok(lab.logs.length > 0);
  assert.ok(!JSON.stringify(result).includes("api_key"));
});
