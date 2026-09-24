const { execFileSync } = require("node:child_process");
const path = require("node:path");
module.exports = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  // Finder metadata copied from the local Electron distribution prevents codesign.
  // Remove only these non-security attributes, never quarantine or provenance.
  for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
    try {
      execFileSync("/usr/bin/xattr", ["-dr", attribute, app], {
        stdio: "pipe",
      });
    } catch (error) {
      const lines = String(error.stderr || "")
        .trim()
        .split("\n");
      if (!lines.every((line) => line.includes("No such xattr"))) throw error;
    }
  }
};
