const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
if (process.platform !== "darwin")
  throw new Error("Native selection helper requires macOS.");
const desktop = path.resolve(__dirname, "..");
const out = path.join(desktop, "build/native");
fs.mkdirSync(out, { recursive: true });
for (const [source, name] of [
  ["selection.swift", "otter-selection"],
  ["app-content.swift", "otter-app-content"],
]) {
  const result = spawnSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-O",
      "-module-cache-path",
      path.join(out, "module-cache"),
      path.join(desktop, "electron/native", source),
      "-o",
      path.join(out, name),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
