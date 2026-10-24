const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BodyBridge, resolveExpression } = require("./body.cjs");

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

// Manual timers: nothing in these tests waits for real time.
function clock() {
  const tasks = [];
  return {
    tasks,
    schedule: (fn, ms) => {
      const task = { fn, ms };
      tasks.push(task);
      return task;
    },
    cancel: (task) => {
      const i = tasks.indexOf(task);
      if (i >= 0) tasks.splice(i, 1);
    },
    async runNext() {
      tasks.shift().fn();
      await flush();
    },
  };
}

const PIXEL_INFO = { firmware: "otter-face-0.5.0", skin: "pixel_game" };
const PIXEL_FACES = [
  "idle",
  "happy",
  "sleeping",
  "thinking",
  "speaking",
  "working",
  "focus",
  "eating",
  "reminder",
  "offline",
  "waking",
];

function fakeSerial({
  ports,
  info = PIXEL_INFO,
  faces = PIXEL_FACES,
  available = true,
  replies = true,
} = {}) {
  const device = { written: [], handlers: null, closed: false, opened: 0 };
  const serial = {
    available: () => available,
    list: async () =>
      ports ?? [{ path: "/dev/tty.usbmodem3101", vendorId: "303A" }],
    open: async (path, handlers) => {
      Object.assign(device, {
        path,
        handlers,
        closed: false,
        opened: device.opened + 1,
      });
      return {
        write(line) {
          device.written.push(line);
          if (!replies) return;
          if (line === "INFO")
            queueMicrotask(() => handlers.onLine(JSON.stringify(info)));
          if (line === "FACE LIST")
            queueMicrotask(() => handlers.onLine(JSON.stringify({ faces })));
        },
        close() {
          device.closed = true;
        },
      };
    },
  };
  return { serial, device };
}

async function connected(options) {
  const timers = clock();
  const { serial, device } = fakeSerial(options);
  const bridge = new BodyBridge({
    serial,
    schedule: timers.schedule,
    cancel: timers.cancel,
    now: () => 1000,
  });
  bridge.configure({ enabled: true });
  await timers.runNext();
  return { bridge, device, timers };
}

test("expression priority follows the desktop pet and splits busy into thinking/working", () => {
  const base = { online: true, connection: "online" };
  assert.equal(resolveExpression(base, 0), "idle");
  assert.equal(resolveExpression({ ...base, focus: true }, 0), "focus");
  assert.equal(
    resolveExpression({ ...base, focus: true, jobStatus: "running" }, 0),
    "working",
  );
  assert.equal(
    resolveExpression(
      { ...base, jobStatus: "running", chatStatus: "streaming" },
      0,
    ),
    "thinking",
  );
  assert.equal(
    resolveExpression({ jobStatus: "running", connection: "connecting" }, 0),
    "idle",
  );
  assert.equal(
    resolveExpression({ connection: "offline", chatStatus: "streaming" }, 0),
    "offline",
  );
  const asleep = {
    ...base,
    pet: { asleep: true, effect: null },
    chatStatus: "streaming",
  };
  assert.equal(resolveExpression(asleep, 0), "sleeping");
  assert.equal(
    resolveExpression({ ...asleep, dueReminders: 1 }, 0),
    "reminder",
  );
  const eating = {
    ...base,
    dueReminders: 1,
    pet: { effect: { mood: "eating", expiresAt: 5000 } },
  };
  assert.equal(resolveExpression(eating, 1000), "eating");
  assert.equal(
    resolveExpression(eating, 6000),
    "reminder",
    "an expired effect no longer counts",
  );
  assert.equal(
    resolveExpression({ ...eating, speaking: true }, 1000),
    "speaking",
  );
});

test("off by default: no serial access at all, events are still accepted", () => {
  const touch = () =>
    assert.fail("serial must not be touched while the bridge is off");
  const timers = clock();
  const bridge = new BodyBridge({
    serial: { available: touch, list: touch, open: touch },
    ...timers,
  });
  bridge.observe({ type: "connection", data: { status: "online" } });
  bridge.observe({ type: "chat.activity", data: { status: "streaming" } });
  bridge.observe(null);
  bridge.observe({ type: "unknown" });
  assert.equal(bridge.snapshot().status, "off");
  assert.equal(bridge.snapshot().expression, "thinking");
  assert.equal(timers.tasks.length, 0);
});

test("without the serial library the bridge reports unavailable and stops", async () => {
  const timers = clock();
  const { serial } = fakeSerial({ available: false });
  const bridge = new BodyBridge({
    serial,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  bridge.configure({ enabled: true });
  await timers.runNext();
  assert.equal(bridge.snapshot().status, "unavailable");
  assert.match(bridge.snapshot().message, /桌面功能不受影响/);
  assert.equal(timers.tasks.length, 0, "no retry loop without the library");
  bridge.observe({ type: "chat.activity", data: { status: "streaming" } });
});

test("no device: keeps searching with backoff and never throws", async () => {
  const timers = clock();
  const { serial, device } = fakeSerial({
    ports: [{ path: "/dev/tty.other", vendorId: "1a86" }],
  });
  const bridge = new BodyBridge({
    serial,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  bridge.configure({ enabled: true });
  await timers.runNext();
  assert.equal(bridge.snapshot().status, "searching");
  assert.match(bridge.snapshot().message, /没有找到/);
  assert.deepEqual(
    timers.tasks.map((t) => t.ms),
    [2000],
  );
  await timers.runNext();
  await timers.runNext();
  assert.deepEqual(
    timers.tasks.map((t) => t.ms),
    [10000],
  );
  assert.equal(device.opened, 0, "the servo adapter's CH343 is never opened");
});

test("connects, then sends a face only when the expression changes", async () => {
  const { bridge, device } = await connected();
  assert.equal(device.path, "/dev/cu.usbmodem3101", "tty.* is opened as cu.*");
  assert.equal(bridge.snapshot().status, "connected");
  assert.deepEqual(device.written, ["INFO", "FACE LIST", "FACE idle"]);
  device.written.length = 0;
  bridge.observe({ type: "connection", data: { status: "online" } });
  bridge.observe({ type: "chat.activity", data: { status: "streaming" } });
  bridge.observe({ type: "chat.activity", data: { status: "streaming" } });
  bridge.observe({ type: "chat.activity", data: { status: "idle" } });
  bridge.observe({ type: "job.changed", data: { status: "running" } });
  bridge.observe({ type: "voice.activity", data: { speaking: true } });
  bridge.observe({ type: "voice.activity", data: { speaking: false } });
  bridge.observe({ type: "job.changed", data: { status: "finished" } });
  bridge.observe({
    type: "connection",
    data: { status: "offline", message: "x" },
  });
  assert.deepEqual(device.written, [
    "FACE thinking",
    "FACE idle",
    "FACE working",
    "FACE speaking",
    "FACE working",
    "FACE idle",
    "FACE offline",
  ]);
});

test("a newly due reminder chirps once and shows reminder; quiet mode stays silent", async () => {
  const { bridge, device } = await connected();
  device.written.length = 0;
  const due = (ids) => ({
    reminders: ids.map((id) => ({ id, status: "due", title: "secret" })),
    focus: null,
  });
  bridge.observe({ type: "assistant.changed", data: due(["a"]) });
  bridge.observe({ type: "assistant.changed", data: due(["a"]) });
  assert.deepEqual(device.written, ["SOUND chirp", "FACE reminder"]);
  assert(
    !device.written.some((l) => l.includes("secret")),
    "reminder text never leaves the Mac",
  );
  bridge.observe({ type: "preferences", data: { quiet: true } });
  bridge.observe({ type: "assistant.changed", data: due(["a", "b"]) });
  bridge.observe({ type: "assistant.changed", data: due([]) });
  assert.deepEqual(device.written.slice(2), ["FACE idle"]);
});

test("pet effects and sleep are mirrored", async () => {
  const { bridge, device } = await connected();
  device.written.length = 0;
  bridge.observe({
    type: "pet.changed",
    data: {
      asleep: false,
      mood: "eating",
      effect: { mood: "eating", expiresAt: 5000 },
    },
  });
  bridge.observe({
    type: "pet.changed",
    data: { asleep: true, mood: "sleeping", effect: null },
  });
  assert.deepEqual(device.written, ["FACE eating", "FACE sleeping"]);
});

test("firmware without the pixel pack gets drawn faces only and is never asked FACE LIST", async () => {
  const { bridge, device } = await connected({
    info: { firmware: "otter-face-0.4.0" },
  });
  assert.deepEqual(device.written, ["INFO", "FACE idle"]);
  bridge.observe({ type: "connection", data: { status: "online" } });
  bridge.observe({ type: "job.changed", data: { status: "running" } });
  bridge.observe({ type: "chat.activity", data: { status: "streaming" } });
  assert.deepEqual(
    device.written.slice(2),
    ["FACE thinking"],
    "working is not a drawn face, so idle stays",
  );
});

test("screen taps become tap events; listener errors stay inside the bridge", async () => {
  const { bridge, device } = await connected();
  let taps = 0;
  bridge.on("tap", () => taps++);
  bridge.on("tap", () => {
    throw new Error("listener bug");
  });
  device.handlers.onLine("EVENT screen_touch 4");
  device.handlers.onLine("EVENT servo 1 arrived 511 diff +0");
  device.handlers.onLine("ERR unsupported face");
  assert.equal(taps, 1);
});

test("unplugging retries, and reconnecting resends the current face", async () => {
  const { bridge, device, timers } = await connected();
  bridge.observe({ type: "chat.activity", data: { status: "streaming" } });
  device.handlers.onClose();
  assert.equal(bridge.snapshot().status, "searching");
  bridge.observe({ type: "chat.activity", data: { status: "idle" } });
  bridge.observe({ type: "voice.activity", data: { speaking: true } });
  device.written.length = 0;
  await timers.runNext();
  assert.equal(bridge.snapshot().status, "connected");
  assert.deepEqual(device.written, ["INFO", "FACE LIST", "FACE speaking"]);
});

test("a device that is not Otter firmware is closed and retried later", async () => {
  const { bridge, device, timers } = await connected({
    info: { firmware: "style-preview" },
  });
  assert.equal(bridge.snapshot().status, "searching");
  assert.match(bridge.snapshot().message, /不是 Otter 固件/);
  assert(device.closed);
  assert.deepEqual(
    timers.tasks.map((t) => t.ms),
    [2000],
  );
});

test("a silent device times out and is retried", async () => {
  const { bridge, device, timers } = await connected({ replies: false });
  assert.deepEqual(
    timers.tasks.map((t) => t.ms),
    [3000],
  );
  await timers.runNext();
  assert.equal(bridge.snapshot().status, "searching");
  assert(device.closed);
});

test("turning it off closes the port and cancels retries; status listeners cannot break it", async () => {
  const { bridge, device, timers } = await connected();
  bridge.on("changed", () => {
    throw new Error("listener bug");
  });
  bridge.configure({ enabled: false });
  assert(device.closed);
  assert.equal(bridge.snapshot().status, "off");
  assert.equal(timers.tasks.length, 0);
  device.written.length = 0;
  bridge.observe({ type: "chat.activity", data: { status: "streaming" } });
  assert.deepEqual(device.written, []);
});
