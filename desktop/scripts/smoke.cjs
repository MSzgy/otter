// Electron needs Playwright's Electron launcher rather than a browser-only CLI.
const { _electron: electron } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const http = require("node:http");
(async () => {
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "otter-desktop-smoke-"),
  );
  const output = path.resolve(__dirname, "../../output/playwright");
  fs.mkdirSync(output, { recursive: true });
  const requests = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      const body = JSON.parse(text);
      requests.push({ url: req.url, body, auth: req.headers.authorization });
      res.setHeader("Content-Type", "application/json");
      if (body.model === "bad-model") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "private-server-error" }));
        return;
      }
      const content =
        body.messages.at(-1).content === "Reply with only OK."
          ? "OK"
          : "# OpenAI 兼容接口测试成功";
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
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
    await panel.getByRole("button", { name: "偏好设置" }).click();
    await panel
      .getByRole("textbox", { name: "API Base URL", exact: true })
      .fill(apiUrl);
    await panel
      .getByRole("textbox", { name: "模型名称", exact: true })
      .fill("bad-model");
    await panel
      .getByRole("checkbox", { name: "使用 API Key", exact: true })
      .uncheck();
    await panel.getByRole("button", { name: "测试连接", exact: true }).click();
    await panel.getByText(/模型服务 HTTP 401/).waitFor();
    assert(
      !(await panel.getByText("private-server-error", { exact: true }).count()),
    );
    await panel
      .getByRole("textbox", { name: "模型名称", exact: true })
      .fill("fixture-model");
    await panel.getByRole("button", { name: "测试连接", exact: true }).click();
    await panel.getByText(/连接成功，模型已返回文本/).waitFor();
    await panel
      .getByRole("button", { name: "保存并启用", exact: true })
      .click();
    await panel.getByText(/已保存并启用/).waitFor();
    await panel
      .getByRole("heading", { name: "模型配置", exact: true })
      .scrollIntoViewIfNeeded();
    await panel.screenshot({
      path: path.join(output, "otter-model-settings.png"),
    });
    await panel.evaluate(() => window.otter.action("reconnect"));
    await panel
      .getByRole("button", { name: "测试连接", exact: true })
      .waitFor();
    await panel.waitForFunction(
      () =>
        document.querySelector('[aria-label="模型名称"]')?.value ===
        "fixture-model",
    );
    await panel.getByRole("button", { name: "工作简报" }).click();
    await panel.getByRole("button", { name: "生成简报", exact: true }).click();
    await panel
      .getByRole("heading", { name: "OpenAI 兼容接口测试成功", exact: true })
      .waitFor({ timeout: 30000 });
    assert(requests.length >= 3);
    assert(requests.every((r) => r.url === "/v1/chat/completions" && !r.auth));
    await panel.getByRole("button", { name: "偏好设置" }).click();
    await panel
      .getByRole("button", { name: "恢复原模型", exact: true })
      .click();
    await panel.getByText("离线演示模式", { exact: true }).waitFor();
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
      "PASS: real Electron report generation, persistence after reconnect, quiet setting, OpenAI model test/save/reconnect/generation/reset, IPC allowlist.",
    );
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userData, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
