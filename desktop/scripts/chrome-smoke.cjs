// Use two owned local pages, never inspect or close unrelated user tabs.
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const run = promisify(execFile);
const { nativeRead } = require("../electron/awareness.cjs");
const { readPage } = require("../electron/page-reader.cjs");
(async () => {
  const token = crypto.randomUUID();
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<title>Otter browser check ${req.url.endsWith("one") ? "one" : "two"}</title><article><h1>Otter browser check</h1><p>${req.url.endsWith("one") ? "FIRST OWNED PAGE" : "SECOND OWNED PAGE"}</p></article>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const prefix = `http://127.0.0.1:${server.address().port}/${token}/`;
  try {
    await run("/usr/bin/open", [
      "-a",
      "Google Chrome",
      prefix + "one",
      prefix + "two",
    ]);
    let observed,
      owned = [];
    for (let i = 0; i < 30; i++) {
      observed = await nativeRead("browser", "com.google.Chrome");
      owned = (observed.tabs || []).filter((t) => t.url.startsWith(prefix));
      if (owned.length === 2) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(
      owned.length,
      2,
      "Chrome should expose both already-open local test tabs",
    );
    console.log(
      "PASS: actual Chrome lists two existing test tabs; window count:",
      observed.windowCount,
    );
    const first = owned.find((t) => t.url === prefix + "one");
    try {
      const text = await readPage("com.google.Chrome", {
        windowId: first.windowId,
        tabId: first.tabId,
        title: first.title,
      });
      assert(text.includes("FIRST OWNED PAGE"));
      console.log("PASS: selected existing Chrome tab body read correctly");
    } catch (error) {
      console.log("BODY_CHECK:", error.message);
      if (!/JavaScript|权限|允许/.test(error.message)) throw error;
    }
  } finally {
    try {
      await run("/usr/bin/osascript", [
        "-l",
        "JavaScript",
        "-e",
        'function run(a){var b=Application("com.google.Chrome");if(!b.running())return;b.windows().forEach(function(w){w.tabs().forEach(function(t){if(String(t.url()).indexOf(a[0])===0)t.close();});});}',
        prefix,
      ]);
    } catch {
      console.log("Owned test tabs could not be closed automatically.");
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
