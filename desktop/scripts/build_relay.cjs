// Cross-compiles relay/ (Go) into build/relay: Linux amd64 and arm64 for
// deploying to a server from 设置 → 手机, and this Mac's own for the tests.
// Skips quietly when Go is not installed and nothing has been built before.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "../../relay");
const out = path.resolve(__dirname, "../build/relay");
const targets = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  [
    process.platform === "darwin" ? "darwin" : process.platform,
    process.arch === "x64" ? "amd64" : process.arch,
  ],
];
let version = "dev";
try {
  version = execFileSync("git", ["describe", "--always", "--dirty"], {
    cwd: source,
  })
    .toString()
    .trim();
} catch {
  // not a git checkout
}
try {
  execFileSync("go", ["version"], { stdio: "ignore" });
} catch {
  if (fs.existsSync(out)) process.exit(0);
  console.error("Go is needed to build the relay (brew install go).");
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
for (const [os, arch] of targets) {
  const file = path.join(out, `otter-relay-${os}-${arch}`);
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${version}`,
      "-o",
      file,
      ".",
    ],
    {
      cwd: source,
      env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: "0" },
      stdio: "inherit",
    },
  );
  console.log(`relay: ${path.relative(process.cwd(), file)}`);
}
