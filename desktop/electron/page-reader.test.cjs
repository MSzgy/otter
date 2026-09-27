const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatPage, readPage } = require("./page-reader.cjs");
test("page preview has source and accurately labels truncation", () => {
  const text = formatPage(
    {
      status: "ready",
      title: "Article",
      url: "https://example.com/story?secret=yes",
      text: "Body",
      truncated: true,
    },
    "com.google.Chrome",
  );
  assert(
    text.includes("Body") &&
      text.includes("摘录") &&
      text.includes("https://example.com/story"),
  );
  assert(!text.includes("secret=yes"));
});
test("empty and non-web pages cannot masquerade as readable articles", async () => {
  assert.throws(
    () => formatPage({ status: "empty" }, "com.google.Chrome"),
    /没有读到/,
  );
  assert.throws(
    () =>
      formatPage(
        { status: "ready", text: "private", url: "file:///secret" },
        "com.google.Chrome",
      ),
    /HTTP/,
  );
  await assert.rejects(readPage("unknown.app"), /不支持/);
});

test("process failures distinguish timeout, denial and tool crash without leaking stderr", async () => {
  const cases = [
    [{ killed: true, signal: "SIGTERM" }, "", /超时/],
    [{ code: 1 }, "Apple event denied (-1743)", /自动化权限/],
    [{ code: 1 }, "No such object (-1728)", /标签页已关闭/],
    [{ signal: "SIGABRT" }, "private page title", /工具异常退出/],
  ];
  for (const [error, stderr, expected] of cases) {
    await assert.rejects(
      readPage("com.google.Chrome", {}, (f, a, o, cb) => cb(error, "", stderr)),
      (e) =>
        expected.test(e.message) && !e.message.includes("private page title"),
    );
  }
});
test("invalid native output is not reported as a missing permission", async () => {
  await assert.rejects(
    readPage("com.google.Chrome", {}, (f, a, o, cb) =>
      cb(null, "not json", ""),
    ),
    /没有返回有效正文/,
  );
});
