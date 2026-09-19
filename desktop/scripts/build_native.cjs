const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
if (process.platform !== "darwin")
  throw new Error("Native selection helper requires macOS.");
const desktop = path.resolve(__dirname, "..");
const out = path.join(desktop, "build/native");
fs.mkdirSync(out, { recursive: true });
const result = spawnSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-O",
    "-module-cache-path",
    path.join(out, "module-cache"),
    path.join(desktop, "electron/native/selection.swift"),
    "-o",
    path.join(out, "otter-selection"),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
