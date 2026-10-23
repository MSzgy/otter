import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => {
    if (["node_modules", "output", ".git"].includes(entry.name)) return [];
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? files(location) : entry.name.endsWith(".mjs") ? [location] : [];
  }));
  return groups.flat();
}
for (const filename of await files(root)) {
  const result = spawnSync(process.execPath, ["--check", filename], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("全部 JavaScript 模块语法检查通过。");
