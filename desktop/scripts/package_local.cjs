// Sign outside file-provider managed folders (e.g. Documents/iCloud).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
if (process.platform !== "darwin")
  throw new Error("Local package supports macOS only.");
const desktop = path.resolve(__dirname, "..");
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "otter-package-"));
const directory = `mac${process.arch === "x64" ? "" : `-${process.arch}`}`;
const stagedApp = path.join(staging, directory, "Otter.app");
const verify = path.join(__dirname, "verify_signature.cjs");
try {
  execFileSync(
    process.execPath,
    [
      require.resolve("electron-builder/cli.js"),
      "--dir",
      `--config.directories.output=${staging}`,
    ],
    { cwd: desktop, stdio: "inherit" },
  );
  execFileSync(process.execPath, [verify, stagedApp], { stdio: "inherit" });
  const archive = path.join(desktop, "release", `Otter-${process.arch}.zip`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  execFileSync(
    "/usr/bin/ditto",
    ["-c", "-k", "--keepParent", stagedApp, archive],
    { stdio: "inherit" },
  );
  console.log(`Verified local app: ${stagedApp}`);
  console.log(`Archive: ${archive}`);
  console.log(
    "Install into ~/Applications or /Applications, outside file-provider folders.",
  );
} catch (error) {
  console.error(`Build failed. Staging retained for diagnosis: ${staging}`);
  throw error;
}
