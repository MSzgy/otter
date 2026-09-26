const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function execute(file, app, args) {
  const context = { browserTarget: () => app };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "native", file), "utf8"),
    context,
  );
  return JSON.parse(context.run(args));
}
function tab(id, title, url = "https://example.com/") {
  return {
    id: () => id,
    title: () => title,
    url: () => url,
    index: () => id,
    name: () => title,
    execute: () =>
      JSON.stringify({ status: "ready", title, url, text: "Body " + id }),
  };
}
function fixture() {
  const first = tab(1, "First"),
    second = tab(2, "Second"),
    third = tab(3, "Third");
  const windows = [
    { id: () => 10, tabs: () => [first, second], activeTab: () => second },
    { id: () => 20, tabs: () => [third], activeTab: () => third },
  ];
  return { running: () => true, windows: () => windows };
}
test("enumerates callable JXA collections, including inactive tabs in every window", () => {
  const app = fixture();
  assert.equal(app.windows.length, 0);
  assert.equal(app.windows().length, 2);
  const result = execute("browser.js", app, ["com.google.Chrome"]);
  assert.equal(result.status, "ready");
  assert.equal(result.windowCount, 2);
  assert.equal(result.tabs.length, 3);
  assert.equal(result.tabs[0].active, false);
  assert.equal(result.tabs[1].active, true);
  assert.equal(result.title, "Second");
});
test("selected Chrome tab is read by window/tab identity rather than current active tab", () => {
  const result = execute("page.js", fixture(), [
    "com.google.Chrome",
    "fixed source",
    JSON.stringify({ windowId: "10", tabId: "1" }),
  ]);
  assert.equal(result.text, "Body 1");
});
test("a closed selected tab reports stale instead of reading a different active tab", () => {
  const result = execute("page.js", fixture(), [
    "com.google.Chrome",
    "fixed source",
    JSON.stringify({ windowId: "10", tabId: "999" }),
  ]);
  assert.equal(result.status, "stale_tab");
});
test("no window and disabled JavaScript are distinguishable", () => {
  assert.equal(
    execute("page.js", { running: () => true, windows: () => [] }, [
      "com.google.Chrome",
      "source",
    ]).status,
    "no_window",
  );
  const app = fixture();
  app.windows()[0].tabs()[0].execute = () => {
    throw new Error("Executing JavaScript is disabled");
  };
  assert.equal(
    execute("page.js", app, [
      "com.google.Chrome",
      "source",
      JSON.stringify({ windowId: "10", tabId: "1" }),
    ]).status,
    "javascript_permission_required",
  );
});

test("native scripts pass the selected PID without bundle-only fallback", () => {
  for (const file of ["browser.js", "page.js"]) {
    let observed;
    const context = {
      browserTarget: (id, pid) => {
        observed = { id, pid };
        return { running: () => false };
      },
    };
    vm.createContext(context);
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "native", file), "utf8"),
      context,
    );
    const args =
      file === "browser.js"
        ? ["com.google.Chrome", "22"]
        : ["com.google.Chrome", "source", JSON.stringify({ pid: 22 })];
    assert.equal(JSON.parse(context.run(args)).status, "not_running");
    assert.deepEqual(observed, { id: "com.google.Chrome", pid: 22 });
  }
});
test("ScriptingBridge adapter uses Objective-C selectors for dynamic page commands", () => {
  const selectors = [];
  const array = (items) => ({
    count: items.length,
    objectAtIndex: (i) => items[i],
  });
  const rawTab = {
    valueForKey: (key) =>
      ({ id: 1, URL: "https://example.com/", title: "Fixture" })[key],
    performSelectorWithObject: (selector, source) => {
      selectors.push([selector, source]);
      return JSON.stringify({ status: "ready", text: "Fixture body" });
    },
  };
  const rawWindow = {
    valueForKey: (key) =>
      ({ id: 10, tabs: array([rawTab]), activeTab: rawTab })[key],
  };
  const rawApp = {
    isNil: () => false,
    running: true,
    valueForKey: (key) => (key === "windows" ? array([rawWindow]) : null),
  };
  const $ = Object.assign((value) => value, {
    NSRunningApplication: {
      runningApplicationWithProcessIdentifier: () => ({
        isNil: () => false,
        terminated: false,
        bundleIdentifier: "com.google.Chrome",
      }),
    },
    SBApplication: { applicationWithProcessIdentifier: () => rawApp },
    OtterBrowserEventDelegate: { alloc: { init: {} } },
  });
  const context = {
    $,
    ObjC: { import: () => {}, unwrap: (v) => v, registerSubclass: () => {} },
  };
  vm.createContext(context);
  for (const file of ["browser-target.js", "page.js"])
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "native", file), "utf8"),
      context,
    );
  const result = JSON.parse(
    context.run([
      "com.google.Chrome",
      "fixed source",
      JSON.stringify({ pid: 22, windowId: "10", tabId: "1" }),
    ]),
  );
  assert.equal(result.text, "Fixture body");
  assert.deepEqual(selectors, [["executeJavascript:", "fixed source"]]);
});
test("adapter TypeErrors are not misreported as JavaScript permission errors", () => {
  const app = fixture();
  app.windows()[0].tabs()[0].execute = () => {
    throw new TypeError("raw.executeJavascript is not a function");
  };
  const result = execute("page.js", app, [
    "com.google.Chrome",
    "source",
    JSON.stringify({ windowId: "10", tabId: "1" }),
  ]);
  assert.equal(result.status, "read_failed");
});
