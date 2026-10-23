import { HardwareLab } from "./src/lab.mjs";
import { drawFace } from "./src/face.mjs";
import { MOOD_LABELS, ACTION_LABELS } from "./src/protocol.mjs";
import { LIMITS } from "./src/body.mjs";

const $ = (id) => document.getElementById(id);
let lab = new HardwareLab();
let lastLogRevision = -1;
let portrait = false;
const canvas = $("face");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const directionLabels = { system: "状态", out: "Mac →", in: "← 设备", ack: "确认", blocked: "拦截", local: "本地" };
const formatTime = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };

function manual(operation) {
  lab.interrupt();
  operation();
  update();
}

document.querySelectorAll("[data-mood]").forEach((button) => {
  button.addEventListener("click", () => manual(() => lab.express(button.dataset.mood)));
});
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => manual(() => lab.perform(button.dataset.action)));
});
document.querySelectorAll("[data-fault]").forEach((button) => {
  button.addEventListener("click", () => {
    lab.fault(button.dataset.fault);
    $("trace-panel").open = true;
    update();
  });
});
$("touch-button").addEventListener("click", () => manual(() => lab.input("touch")));
$("long-press-button").addEventListener("click", () => manual(() => lab.input("long_press")));
$("conversation-demo").addEventListener("click", () => { lab.conversation(); update(); });
$("stop-motion").addEventListener("click", () => { lab.stop(); update(); });
$("toggle-connection").addEventListener("click", () => {
  if (lab.body.connected) lab.disconnect(); else lab.connect();
  update();
});

let pressTimer = null;
let longPressed = false;
const sensor = $("head-touch");
function clearPress() {
  window.clearTimeout(pressTimer);
  pressTimer = null;
  sensor.classList.remove("holding");
}
sensor.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  longPressed = false;
  sensor.setPointerCapture(event.pointerId);
  sensor.classList.add("holding");
  pressTimer = window.setTimeout(() => {
    longPressed = true;
    clearPress();
    manual(() => lab.input("long_press"));
  }, 1000);
});
sensor.addEventListener("pointerup", clearPress);
sensor.addEventListener("pointercancel", () => { longPressed = true; clearPress(); });
sensor.addEventListener("lostpointercapture", clearPress);
sensor.addEventListener("click", (event) => {
  if (!longPressed || event.detail === 0) manual(() => lab.input("touch"));
  longPressed = false;
});

const sliders = {
  "touch-duration": ["touchDuration", (value) => value],
  "nod-duration": ["nodDuration", (value) => value],
  strength: ["strength", (value) => value / 100],
  latency: ["latency", (value) => value],
};
for (const [id, [key, convert]] of Object.entries(sliders)) {
  $(id).addEventListener("input", () => { lab.configure({ [key]: convert(Number($(id).value)) }); update(); });
}
$("screen-only").addEventListener("change", () => manual(() => lab.configure({ motionEnabled: !$("screen-only").checked })));
$("orientation").addEventListener("click", () => {
  portrait = !portrait;
  canvas.width = portrait ? 240 : 320;
  canvas.height = portrait ? 320 : 240;
  document.querySelector(".device").classList.toggle("portrait", portrait);
  text("screen-size", portrait ? "240 × 320 · 竖屏预览" : "320 × 240 · 横屏预览");
  text("orientation", portrait ? "切换为横屏" : "切换为竖屏");
  update();
});

const dialog = $("guide-dialog");
$("open-guide").addEventListener("click", () => dialog.showModal());
$("close-guide").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});

$("reset-lab").addEventListener("click", () => {
  lab.stop();
  clearPress();
  lab = new HardwareLab();
  lastLogRevision = -1;
  $("touch-duration").value = "2800";
  $("nod-duration").value = "1400";
  $("strength").value = "65";
  $("latency").value = "80";
  $("screen-only").checked = false;
  update();
});

$("export-trace").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(lab.exportTrace(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `otter-lab-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function renderLogs() {
  // 用 DOM textContent 呈现日志，后续接设备时也不把收到的内容当作 HTML。
  const list = $("trace-list");
  const nearTop = list.scrollTop < 30;
  const openIds = new Set(Array.from(list.querySelectorAll("details[open]")).map((el) => el.dataset.key));
  const nodes = [...lab.logs].reverse().map((entry) => {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.className = "trace-time";
    time.textContent = formatTime(entry.at);
    const direction = document.createElement("span");
    direction.className = `trace-direction ${entry.direction}`;
    direction.textContent = directionLabels[entry.direction] || entry.direction;
    const content = document.createElement("div");
    content.className = "trace-content";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const detail = document.createElement("p");
    detail.textContent = entry.detail;
    content.append(title, detail);
    if (entry.packet) {
      const details = document.createElement("details");
      details.dataset.key = String(entry.key);
      details.open = openIds.has(String(entry.key));
      const summary = document.createElement("summary");
      summary.textContent = "查看消息";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(entry.packet, null, 2);
      details.append(summary, pre);
      content.append(details);
    }
    li.append(time, direction, content);
    return li;
  });
  const scroll = list.scrollTop;
  list.replaceChildren(...nodes);
  list.scrollTop = nearTop ? 0 : scroll;
}

function update() {
  const state = lab.snapshot();
  const pose = state.pose;
  drawFace(canvas, state.mood, Date.now(), { reducedMotion: reducedMotion.matches });
  // 仅作两轴姿态示意；真实结构的旋转轴与角度需要装配后标定。
  $("head-pivot").style.transform = reducedMotion.matches ? "none" : `perspective(700px) rotateY(${pose.pan * .8}deg) rotateX(${pose.tilt * .7}deg)`;
  $("pan-indicator").style.left = `${50 + pose.pan / LIMITS.pan * 45}%`;
  $("tilt-indicator").style.left = `${50 + pose.tilt / LIMITS.tilt * 45}%`;
  text("pan-value", `${Math.round(pose.pan)}°`);
  text("tilt-value", `${Math.round(pose.tilt)}°`);
  text("mood-label", MOOD_LABELS[state.mood]);
  text("action-label", state.action ? ACTION_LABELS[state.action] : state.sleeping ? "长按头顶叫醒" : state.pending ? "等待指令送达" : "等你摸摸头");
  text("notice", state.notice);
  text("connection-label", state.connected ? "模拟设备已连接" : "模拟设备已断开");
  text("toggle-connection", state.connected ? "断开模拟连接" : "连接模拟设备");
  $("connection-pill").classList.toggle("offline", !state.connected);
  $("shell-dot").classList.toggle("offline", !state.connected);
  canvas.setAttribute("aria-label", `水獭：${MOOD_LABELS[state.mood]}`);
  document.querySelectorAll("[data-mood]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mood === state.mood));
    button.disabled = !state.connected;
  });
  document.querySelectorAll("[data-action]").forEach((button) => { button.disabled = !state.connected || state.sleeping; });
  document.querySelectorAll("[data-fault]").forEach((button) => { button.disabled = !state.connected || state.sleeping; });
  $("conversation-demo").disabled = !state.connected;
  for (const key of Object.keys(state.lesson)) $(`step-${key}`).classList.toggle("done", state.lesson[key]);
  text("touch-duration-value", `${(state.settings.touchDuration / 1000).toFixed(1)} 秒`);
  text("nod-duration-value", `${(state.settings.nodDuration / 1000).toFixed(1)} 秒`);
  text("strength-value", `${Math.round(state.settings.strength * 100)}%`);
  text("latency-value", `${state.settings.latency} 毫秒`);
  text("trace-count", String(lab.logs.length));
  const blocked = state.metrics.duplicates + state.metrics.expired + state.metrics.rejected;
  text("trace-summary", state.metrics.actions || blocked
    ? `执行 ${state.metrics.actions} 次动作 · 拦截 ${blocked} 条指令`
    : "展开看 Mac 与模拟设备怎样配合");
  if (lastLogRevision !== state.revision) {
    renderLogs();
    lastLogRevision = state.revision;
  }
}

let frame;
let lastPaint = 0;
function loop(timestamp) {
  if (timestamp - lastPaint > 32) {
    update();
    lastPaint = timestamp;
  }
  frame = window.requestAnimationFrame(loop);
}
document.addEventListener("visibilitychange", () => {
  clearPress();
  window.cancelAnimationFrame(frame);
  if (document.hidden) {
    lab.stop();
    lab.latestNotice = "页面离开前台，预演已暂停；回来后可继续操作。";
  } else {
    lastPaint = 0;
    frame = window.requestAnimationFrame(loop);
  }
});
window.addEventListener("pagehide", () => { clearPress(); window.cancelAnimationFrame(frame); });
update();
frame = window.requestAnimationFrame(loop);
