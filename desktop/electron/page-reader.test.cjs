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
