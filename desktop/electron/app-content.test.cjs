const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AppContentReader } = require("./app-content.cjs");
const app = { pid: 123, bundleId: "test.app", name: "Test editor" };
test("window text has app provenance and remains an explicit context draft", async () => {
  const reader = new AppContentReader("unused");
  reader.run = async () => ({
    status: "ready",
    windows: [
      {
        id: 1,
        title: "Document",
        text: "Actual editor content",
        protectedFieldsSkipped: true,
      },
    ],
  });
  const result = await reader.read(app, "ax");
  assert.equal(result.windows[0].text, "Actual editor content");
  assert(reader.context(result.id).includes("Test editor"));
  reader.clear();
  assert.throws(() => reader.context(result.id), /重新读取/);
});
test("permissions are reported as unavailable, not fabricated content", async () => {
  const reader = new AppContentReader("unused");
  reader.run = async () => ({
    status: "permission_required",
    permission: "accessibility",
  });
  const result = await reader.read(app, "ax");
  assert.equal(result.status, "permission_required");
  assert.deepEqual(result.windows, []);
  assert.throws(() => reader.context(result.id));
});
test("late content after disabling is discarded", async () => {
  const reader = new AppContentReader("unused");
  let complete;
  reader.run = () => new Promise((resolve) => (complete = resolve));
  const promise = reader.read(app, "ocr");
  reader.clear();
  complete({
    status: "ready",
    windows: [{ id: 1, title: "Window", text: "private" }],
  });
  await assert.rejects(promise, /取消/);
  assert.equal(reader.last, null);
});
test("concurrent permission checks share one native call", async () => {
  const reader = new AppContentReader("unused");
  let finish,
    calls = 0;
  reader.run = () => {
    calls++;
    return new Promise((resolve) => (finish = resolve));
  };
  const a = reader.permissions(),
    b = reader.permissions();
  assert.equal(calls, 1);
  finish({ accessibility: false, screenRecording: false });
  assert.deepEqual(await a, await b);
});
