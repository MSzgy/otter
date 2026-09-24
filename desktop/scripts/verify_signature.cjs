// A renamed, unsealed Electron binary is not an Otter signing identity.
// TCC can otherwise authorize the bundle while denying its native child process.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { build } = require("../package.json");
const app =
  process.argv[2] || path.resolve(__dirname, "../release/mac-arm64/Otter.app");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
  stdio: "pipe",
});
const { spawnSync } = require("node:child_process");
const detail = spawnSync(
  "/usr/bin/codesign",
  ["--display", "--verbose=2", app],
  { encoding: "utf8" },
);
const info = detail.stderr + detail.stdout;
if (
  detail.status !== 0 ||
  !info.split("\n").includes(`Identifier=${build.appId}`) ||
  /Info.plist=not bound|Sealed Resources=none/.test(info)
) {
  throw new Error(
    "Otter bundle signing identity is invalid; do not distribute this build.",
  );
}
console.log(`PASS: sealed app signature matches ${build.appId}`);
