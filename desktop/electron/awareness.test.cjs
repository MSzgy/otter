const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Awareness, cleanTab } = require("./awareness.cjs");
const apps = {
  apps: [{ name: "Chrome", bundleId: "com.google.Chrome", pid: 1 }],
  front: { name: "Chrome", bundleId: "com.google.Chrome", pid: 1 },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
test("off by default, enabling apps does not read browser; disabling clears all", async () => {
  const calls = [];
  const a = new Awareness({
    platform: "darwin",
    read: async (kind) => {
      calls.push(kind);
      return apps;
    },
  });
  try {
    assert.equal(a.snapshot().enabled, false);
    await a.refresh();
    assert.equal(calls.length, 0);
    a.configure({ enabled: true, browserEnabled: false });
    await settle();
    assert.deepEqual(calls, ["apps"]);
    assert.equal(a.snapshot().front.name, "Chrome");
    a.configure({ enabled: false, browserEnabled: false });
    assert.equal(a.snapshot().front, null);
    assert.deepEqual(a.snapshot().apps, []);
  } finally {
    a.close();
  }
});
test("permission rejection pauses repeated polling until an explicit retry", async () => {
  let reads = 0;
  const a = new Awareness({
    platform: "darwin",
    read: async (kind) => {
      if (kind === "apps") return apps;
      reads++;
      const e = new Error("raw secret");
      e.code = "DENIED";
      throw e;
    },
  });
  try {
    a.configure({ enabled: true, browserEnabled: true });
    await settle();
    await a.refresh();
    assert.equal(reads, 1);
    assert.equal(a.snapshot().browserStatus, "denied");
    assert(a.snapshot().message.includes("自动化"));
    assert(!a.snapshot().message.includes("raw secret"));
    await a.browser("com.google.Chrome");
    assert.equal(reads, 2);
  } finally {
    a.close();
  }
});
test("an in-flight result cannot repopulate state after disabling", async () => {
  let resolve;
  const a = new Awareness({
    platform: "darwin",
    read: () => new Promise((r) => (resolve = r)),
  });
  a.configure({ enabled: true, browserEnabled: false });
  a.configure({ enabled: false, browserEnabled: false });
  resolve(apps);
  await settle();
  assert.deepEqual(a.snapshot().apps, []);
  a.close();
});
test("browser data is sanitized and last observation is distinct from the front app", async () => {
  let front = apps;
  const a = new Awareness({
    platform: "darwin",
    read: async (kind) =>
      kind === "apps"
        ? front
        : {
            status: "ready",
            title: "Example",
            url: "https://u:pass@example.com/page?token=secret#fragment",
          },
  });
  try {
    a.configure({ enabled: true, browserEnabled: true });
    await settle();
    assert.equal(a.snapshot().browser.url, "https://example.com/page");
    front = {
      apps: apps.apps,
      front: { name: "Otter", bundleId: "dev.otter.desktop", pid: 2 },
    };
    await a.refresh();
    assert.equal(a.snapshot().browser.bundleId, "com.google.Chrome");
    assert.equal(a.snapshot().front.bundleId, "dev.otter.desktop");
    a.configure({ enabled: true, browserEnabled: false });
    assert.equal(a.snapshot().browser, null);
    await assert.rejects(a.browser("com.google.Chrome"), /先开启/);
  } finally {
    a.close();
  }
});
test("file, internal and malformed URLs are not exposed", () => {
  for (const url of [
    "file:///private/file",
    "chrome://settings",
    "javascript:alert(1)",
    "invalid",
  ])
    assert.equal(
      cleanTab({ status: "ready", url }, "com.google.Chrome").url,
      "",
    );
});
test("all browser tabs are retained for selection and cleared with browser access", async () => {
  const a = new Awareness({
    platform: "darwin",
    read: async (kind) =>
      kind === "apps"
        ? apps
        : {
            status: "ready",
            title: "Active",
            url: "https://example.com",
            windowCount: 2,
            tabs: [
              {
                windowId: "1",
                tabId: "2",
                windowIndex: 1,
                title: "Inactive",
                url: "https://example.com/a?token=x",
                active: false,
              },
              {
                windowId: "3",
                tabId: "4",
                windowIndex: 2,
                title: "Active",
                url: "https://example.com/b",
                active: true,
              },
            ],
          },
  });
  try {
    a.configure({ enabled: true, browserEnabled: true });
    await settle();
    assert.equal(a.snapshot().tabs.length, 2);
    assert.equal(a.snapshot().tabs[0].url, "https://example.com/a");
    assert.equal(a.snapshot().tabWindowCount, 2);
    a.configure({ enabled: true, browserEnabled: false });
    assert.deepEqual(a.snapshot().tabs, []);
  } finally {
    a.close();
  }
});
