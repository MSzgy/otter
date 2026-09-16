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
      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        const slow = body.messages.at(-1).content === "慢慢回答";
        const first = slow ? "正在慢慢回复" : "你好，我是 Otter。";
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`,
        );
        const timer = setTimeout(
          () => {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: slow ? "不应出现的迟到内容" : "很高兴和你聊天。" } }] })}\n\n`,
            );
            res.end("data: [DONE]\n\n");
          },
          slow ? 4000 : 150,
        );
        res.on("close", () => clearTimeout(timer));
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
    await panel.getByRole("button", { name: "应用感知", exact: false }).click();
    await panel
      .getByRole("heading", { name: "感知已关闭", exact: true })
      .waitFor();
    await panel
      .getByRole("checkbox", { name: "开启应用感知", exact: true })
      .click();
    await panel.waitForFunction(
      () => document.querySelectorAll(".running-app").length > 0,
    );
    const observed = await panel.evaluate(() =>
      window.otter.action("awareness.get"),
    );
    assert(observed.apps.length > 0 && observed.front);
    assert.equal(observed.browserEnabled, false);
    assert.equal(observed.browser, null);
    await panel
      .getByRole("checkbox", { name: "开启应用感知", exact: true })
      .click();
    await panel
      .getByRole("heading", { name: "感知已关闭", exact: true })
      .waitFor();
    assert.equal(
      (await panel.evaluate(() => window.otter.action("awareness.get"))).apps
        .length,
      0,
    );
    await panel.screenshot({ path: path.join(output, "otter-awareness.png") });
    await panel.getByRole("button", { name: "陪伴互动", exact: false }).click();
    await panel.getByRole("heading", { name: "和小水獭玩一会儿。" }).waitFor();
    const beforeRequests = requests.length;
    const labels = ["摸摸头", "喂小鱼", "玩小球", "跳个舞", "打招呼", "挠痒痒"];
    const moods = ["开心", "吃小鱼", "玩小球", "跳舞", "打招呼", "被挠痒痒"];
    for (let i = 0; i < labels.length; i++) {
      await panel.getByRole("button", { name: labels[i], exact: true }).click();
      await pet
        .getByRole("img", { name: `水獭：${moods[i]}`, exact: true })
        .waitFor();
      if (i === 1) {
        await panel
          .locator(".interaction-stage")
          .getByRole("img", { name: "水獭：吃小鱼", exact: true })
          .waitFor();
        await panel.screenshot({
          path: path.join(output, "otter-interactions.png"),
        });
        await pet.screenshot({
          path: path.join(output, "otter-feeding.png"),
          omitBackground: true,
        });
        await panel
          .getByRole("button", { name: "喂小鱼", exact: true })
          .click();
        await panel
          .getByText("小鱼还没吃完，等一会儿再喂吧。", { exact: true })
          .waitFor();
      }
    }
    assert.equal(
      requests.length,
      beforeRequests,
      "Pet interactions must not call any model",
    );
    await panel.getByRole("button", { name: "睡一会儿", exact: true }).click();
    await panel
      .getByRole("button", { name: "叫醒水獭", exact: true })
      .waitFor();
    assert.equal(
      await panel
        .getByRole("button", { name: "玩小球", exact: true })
        .isDisabled(),
      true,
    );
    await pet.getByRole("button", { name: "与水獭聊天", exact: true }).click();
    await panel
      .getByRole("button", { name: "睡一会儿", exact: true })
      .waitFor();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const beforeHead = await pet.evaluate(
      async () => (await window.otter.action("snapshot")).pet.interactions,
    );
    await pet
      .getByRole("button", { name: "与水獭聊天", exact: true })
      .click({ position: { x: 83, y: 58 } });
    await pet.waitForFunction(
      async (count) =>
        (await window.otter.action("snapshot")).pet.interactions === count + 1,
      beforeHead,
    );
    // Intercept native popup solely to inspect its labels and invoke the same action callback.
    await app.evaluate(({ Menu }) => {
      globalThis.__popup = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        globalThis.__petMenu = this;
        globalThis.__petMenuOptions = options;
      };
    });
    await pet
      .getByRole("button", { name: "与水獭聊天", exact: true })
      .click({ button: "right" });
    for (let i = 0; i < 30; i++) {
      if (await app.evaluate(() => !!globalThis.__petMenu)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const menuLabels = await app.evaluate(({ Menu }) => {
      const menu = globalThis.__petMenu;
      const labels = menu.items.map((item) => item.label);
      menu.items.find((item) => item.label === "睡一会儿").click();
      globalThis.__petMenuOptions.callback?.();
      Menu.prototype.popup = globalThis.__popup;
      return labels;
    });
    assert(
      menuLabels.includes("喂小鱼") && menuLabels.includes("打开互动面板"),
    );
    await panel
      .getByRole("button", { name: "叫醒水獭", exact: true })
      .waitFor();
    await panel.evaluate(() => window.otter.action("reconnect"));
    const petSaved = JSON.parse(
      fs.readFileSync(path.join(userData, "desktop.json"), "utf8"),
    ).petState;
    assert.equal(petSaved.asleep, true);
    await panel.getByRole("button", { name: "叫醒水獭", exact: true }).click();
    await panel
      .getByRole("button", { name: "睡一会儿", exact: true })
      .waitFor();
    assert.equal(
      await pet.evaluate(
        async () => (await window.otter.action("snapshot")).pet.asleep,
      ),
      false,
    );
    await panel.getByRole("button", { name: "工作简报" }).click();
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
    await panel
      .getByRole("button", { name: "与水獭聊天", exact: false })
      .click();
    await panel.getByRole("textbox", { name: "聊天输入" }).fill("你好小水獭");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await panel
      .getByText("你好，我是 Otter。很高兴和你聊天。", { exact: true })
      .waitFor();
    await panel.getByRole("button", { name: "发送", exact: true }).waitFor();
    await panel
      .getByRole("textbox", { name: "聊天输入" })
      .fill("还记得我刚才说了什么吗");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await panel.waitForFunction(
      () =>
        document.querySelectorAll(".chat-message.assistant").length === 2 &&
        !document.querySelector(".chat-cursor"),
    );
    const chatCalls = requests.filter((r) => r.body.stream);
    assert.deepEqual(
      chatCalls[1].body.messages.map((m) => m.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(chatCalls[1].body.messages[1].content, "你好小水獭");
    await panel.screenshot({ path: path.join(output, "otter-chat.png") });
    await panel.getByRole("button", { name: "偏好设置" }).click();
    await pet.getByRole("button", { name: "与水獭聊天", exact: true }).click();
    await panel.getByRole("textbox", { name: "聊天输入" }).waitFor();
    await panel.getByRole("textbox", { name: "聊天输入" }).fill("慢慢回答");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await panel.getByText("正在慢慢回复", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "停止回复", exact: true }).click();
    await panel.getByText("已停止回复", { exact: true }).waitFor();
    await panel.evaluate(() => window.otter.action("reconnect"));
    await panel.getByText("已停止回复", { exact: true }).waitFor();
    await panel.waitForFunction(
      () =>
        document.querySelectorAll(".chat-message").length === 6 &&
        document
          .querySelector('[aria-label="聊天消息"]')
          ?.getAttribute("aria-busy") === "false",
    );
    assert.equal(
      await panel.getByText("不应出现的迟到内容", { exact: true }).count(),
      0,
    );
    await panel.getByRole("button", { name: "新对话", exact: true }).click();
    await panel
      .getByRole("heading", { name: "我在这里，慢慢说。", exact: true })
      .waitFor();
    await panel.getByRole("button", { name: "删除对话", exact: true }).click();
    await panel.getByRole("button", { name: "确认删除", exact: true }).click();
    await panel.getByText("已停止回复", { exact: true }).waitFor();
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
      "PASS: real Electron report generation, persistence after reconnect, quiet setting, OpenAI model test/save/reconnect/generation/reset, streaming multi-turn chat, pet entry, cancel, history and deletion, local pet actions, head tap, sleep/wake, native menu wiring, live app awareness toggle/clear, IPC allowlist.",
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
