const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ContextDraft, buildScene, selectionDraft } = require("./context.cjs");
test("scene contains explicit provenance and never implies that URL equals page body", () => {
  const text = buildScene({
    enabled: true,
    lastExternal: { name: "Editor", observedAt: 1000 },
    browser: {
      name: "Chrome",
      title: "Example",
      url: "https://example.com/",
      observedAt: 1000,
    },
  });
  assert(
    text.includes("Editor") &&
      text.includes("未读取网页正文") &&
      text.includes("可能不是当前前台"),
  );
  assert.throws(() => buildScene({ enabled: false }), /开启/);
});
test("draft only clears its own id and expires without storing data", () => {
  const store = new ContextDraft();
  const old = store.set("a", "one");
  const latest = store.set("b", "two");
  store.clear(old.id);
  assert.equal(store.get().text, "b");
  store.clear(latest.id);
  assert.equal(store.get(), null);
  store.set("c", "three");
  store.value.createdAt = Date.now() - 600001;
  assert.equal(store.get(), null);
});
test("selection errors are actionable and protected fields never become attachments", () => {
  assert.throws(
    () => selectionDraft({ status: "permission_required" }),
    /辅助功能/,
  );
  assert.throws(
    () => selectionDraft({ status: "protected", text: "secret" }),
    /受保护/,
  );
  assert.throws(() => selectionDraft({ status: "empty" }), /没有读到/);
  const text = selectionDraft({
    status: "ready",
    app: "Notes",
    text: "example",
  });
  assert(text.includes("Notes") && text.includes("example"));
});
