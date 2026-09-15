// Electron needs Playwright's Electron launcher rather than a browser-only CLI.
const { _electron: electron } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "otter-desktop-smoke-"),
  );
  const output = path.resolve(__dirname, "../../output/playwright");
  fs.mkdirSync(output, { recursive: true });
  let app;
  const errors = [];
  try {
    app = await electron.launch({
      args: process.env.OTTER_TEST_APP ? [] : [path.resolve(__dirname, "..")],
      executablePath: process.env.OTTER_TEST_APP || undefined,
      env: { ...process.env, OTTER_DESKTOP_USER_DATA: userData },
      timeout: 30000,
    });
    let panel, pet;
    for (let i = 0; i < 80; i++) {
      const windows = app.windows();
      panel = windows.find((w) => w.url().includes("view=panel"));
      pet = windows.find((w) => w.url().includes("view=pet"));
      if (panel && pet) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(panel && pet, "Both windows should exist");
    panel.on("pageerror", (e) => errors.push(e.message));
    pet.on("pageerror", (e) => errors.push(e.message));
    console.log(await panel.locator("body").ariaSnapshot());
    await panel
      .getByText("离线演示模式", { exact: true })
      .waitFor({ timeout: 30000 });
    await panel.getByRole("button", { name: "生成简报", exact: true }).click();
    await panel
      .getByRole("heading", { name: "欢迎来到 Otter" })
      .waitFor({ timeout: 30000 });
    await panel.screenshot({ path: path.join(output, "otter-desktop.png") });
    await pet.screenshot({
      path: path.join(output, "otter-pet.png"),
      omitBackground: true,
    });
    const count = await panel.locator(".report-list button").count();
    assert.equal(count, 1);
    await panel.getByRole("button", { name: "偏好设置" }).click();
    await panel.getByRole("checkbox", { name: "安静模式" }).check();
    assert.equal(
      await panel.getByRole("checkbox", { name: "安静模式" }).isChecked(),
      true,
    );
    await panel.screenshot({ path: path.join(output, "otter-settings.png") });
    await panel.evaluate(() => window.otter.action("reconnect"));
    await panel
      .getByText("离线演示模式", { exact: true })
      .waitFor({ timeout: 30000 });
    await panel.getByRole("button", { name: "工作简报" }).click();
    await panel
      .getByRole("heading", { name: "欢迎来到 Otter" })
      .waitFor({ timeout: 30000 });
    // Exercise privileged boundary with a non-allowlisted method.
    const denied = await panel.evaluate(async () => {
      try {
        await window.otter.call("secret.get");
        return false;
      } catch {
        return true;
      }
    });
    assert(denied);
    const properties = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        transparent: w.getBackgroundColor(),
        visible: w.isVisible(),
        focusable: w.isFocusable(),
      })),
    );
    console.log("Window properties:", properties);
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(
      "PASS: real Electron report generation, persistence after reconnect, quiet setting, IPC allowlist.",
    );
  } finally {
    if (app) await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
