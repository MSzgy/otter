// Screenshots every section of the panel for design review. Uses isolated local
// mock data (no model, no device) like the smoke tests; writes PNGs to
// OTTER_UI_OUTPUT (default /tmp/otter-ui). Build first: npm run build.
// Pass place names to shoot only those, or "states" for in-progress screens;
// OTTER_UI_THEME picks a theme, OTTER_UI_SIZE a window size.
const { _electron: electron } = require("playwright");
const http = require("node:http");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
// For "states": a local stand-in for an OpenAI-compatible model, so chat can
// show a real conversation, a task confirmation and a memory suggestion.
function fakeModel() {
  const reply = (res, content) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  return http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      const body = JSON.parse(text || "{}");
      const purpose = body.messages?.[0]?.content || "";
      if (purpose.startsWith("[Otter task planner]")) {
        const payload = JSON.parse(body.messages[1].content);
        const at = new Date(Date.parse(payload.now) + 3600000).toISOString();
        return reply(
          res,
          JSON.stringify(
            payload.text.includes("提醒我")
              ? { kind: "reminder_create", title: "喝杯水", when: { at } }
              : { kind: "none" },
          ),
        );
      }
      if (purpose.startsWith("[Otter memory suggestion]")) {
        const payload = JSON.parse(body.messages[1].content);
        const robot = payload.user_text.includes("桌面机器人");
        return reply(
          res,
          JSON.stringify({
            candidates: robot
              ? [
                  {
                    title: "桌面机器人",
                    content: "最近在做一个会点头、左右看的桌面机器人水獭。",
                    category: "project",
                    evidence: "我最近在做一个桌面机器人",
                  },
                ]
              : [],
          }),
        );
      }
      if (purpose.startsWith("[Otter semantic memory lookup]"))
        return reply(res, JSON.stringify({ ids: [] }));
      if (!body.stream) return reply(res, "OK");
      res.setHeader("Content-Type", "text/event-stream");
      const answer =
        "辛苦啦。我们一起把今天理一理：\n\n- 舵机已经能识别、居中了，这是很实在的进展\n- 支架孔位对不上，先别硬改，等 3D 打印件\n\n要不要先站起来活动五分钟？";
      for (const part of answer.match(/[\s\S]{1,12}/g))
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    });
  });
}
// Screens that only show up while something is going on.
async function shootStates(panel, output, port) {
  const shot = async (id) => {
    await panel.waitForTimeout(600);
    await panel.screenshot({ path: path.join(output, `state-${id}.png`) });
  };
  const button = (name) =>
    panel.getByRole("button", { name, exact: true }).first();
  await panel.evaluate(async (port) => {
    await window.otter.call("models.save", {
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "ui-model",
      api_key: "",
      use_api_key: false,
      max_tokens: 1024,
      timeout_sec: 30,
      token_limit_field: "max_tokens",
    });
    for (const [title, content, category] of [
      ["称呼", "叫我小杨就好。", "profile"],
      ["喝水", "我总忘记喝水，下午要提醒我。", "preference"],
      ["猫", "家里的猫叫糯米，三岁。", "fact"],
    ])
      await window.otter.call("memory.save", { title, content, category });
    await window.otter.action("assistant.create", {
      title: "专注结束，起来休息一下",
      dueAt: Date.now() + 18 * 60000,
      kind: "focus",
      requestId: crypto.randomUUID(),
    });
  }, port);
  await panel.evaluate(() => window.otter.action("reconnect"));
  await panel.waitForFunction(
    async () =>
      (await window.otter.action("snapshot")).health?.provider === "openai",
    {},
    { timeout: 20000 },
  );
  await button("今天").click();
  await shot("today-focus");
  await button("聊天").click();
  const say = async (text) => {
    await panel.getByRole("textbox", { name: "聊天输入" }).fill(text);
    await button("发送").click();
    await button("停止回复").waitFor({ state: "detached", timeout: 15000 });
  };
  await say("今天有点累，我最近在做一个桌面机器人，舵机调了一下午");
  await shot("chat-conversation");
  await panel
    .getByRole("textbox", { name: "聊天输入" })
    .fill("1小时后提醒我喝杯水");
  await button("发送").click();
  await button("确认创建提醒").waitFor({ timeout: 15000 });
  await shot("chat-task");
  await button("取消操作").click();
  await button("删除对话").click();
  await shot("chat-delete");
  await button("保留").click();
  await button("项目").click();
  await button("手动记录进度").click();
  await shot("project-capture");
  await button("取消").click();
  await button("我的水獭").click();
  await shot("otter-memory");
  await button("设置").click();
  await panel
    .getByRole("navigation", { name: "设置分组" })
    .getByRole("button", { name: "隐私与感知" })
    .click();
  await panel
    .getByRole("checkbox", { name: "开启应用感知", exact: true })
    .click();
  await panel.waitForTimeout(2500);
  await panel
    .locator("#settings-privacy")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot("settings-awareness");
  await panel
    .getByRole("checkbox", { name: "开启应用感知", exact: true })
    .click();
  await panel.keyboard.press("Escape");
}
// Places in the rail, then each group of the settings sheet.
const PLACES = [
  ["today", "今天"],
  ["chat", "聊天"],
  ["projects", "项目"],
  ["otter", "我的水獭"],
];
const SETTINGS = [
  ["general", "通用"],
  ["model", "模型"],
  ["privacy", "隐私与感知"],
  ["handoff", "AI 交接"],
  ["body", "实体水獭"],
  ["workspace", "工作空间"],
];
(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "otter-ui-"));
  const userData = path.join(fixture, "user");
  fs.mkdirSync(userData);
  fs.writeFileSync(
    path.join(userData, "desktop.json"),
    JSON.stringify({
      quiet: true,
      body: { enabled: false },
      ambient: { enabled: false },
      shortcuts: { enabled: false },
    }),
  );
  const config = path.join(fixture, "config.toml");
  fs.writeFileSync(
    config,
    '[core]\ntimezone = "Asia/Shanghai"\n[identity]\nprimary = "ui@otter.local"\n[llm]\nprovider = "mock"\n[llm.mock]\nresponse = "# 今日简报\\n\\n- 完成了水獭进化的联调\\n- 下一步：打印头部支架"\n',
  );
  const output = process.env.OTTER_UI_OUTPUT || "/tmp/otter-ui";
  fs.mkdirSync(output, { recursive: true });
  const only = process.argv.slice(2);
  const states = only.includes("states");
  const model = states ? fakeModel() : null;
  if (model) await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      OTTER_DESKTOP_USER_DATA: userData,
      OTTER_DESKTOP_CONFIG: config,
      OTTER_PROJECT_ROOT: fixture,
    },
    timeout: 30000,
  });
  try {
    let panel, pet;
    for (let i = 0; i < 100 && !(panel && pet); i++) {
      panel = app.windows().find((w) => w.url().includes("view=panel"));
      pet = app.windows().find((w) => w.url().includes("view=pet"));
      await new Promise((r) => setTimeout(r, 100));
    }
    await panel.waitForFunction(
      async () => !!(await window.otter.action("snapshot")).health,
      {},
      { timeout: 20000 },
    );
    // OTTER_UI_SIZE=760x560 checks the smallest window the panel allows.
    const [width, height] = (process.env.OTTER_UI_SIZE || "1060x740")
      .split("x")
      .map(Number);
    await panel.setViewportSize({ width, height });
    await panel.waitForFunction(
      async () => {
        try {
          await window.otter.call("projects.list");
          return true;
        } catch {
          return false;
        }
      },
      {},
      { timeout: 20000, polling: 300 },
    );
    // A lived-in day, so cards show content rather than empty states.
    await panel.evaluate(async () => {
      // The backend can still be settling; retry calls that say so.
      const retry = async (fn) => {
        for (let i = 0; i < 60; i++) {
          try {
            return await fn();
          } catch (e) {
            if (!/尚未就绪/.test(String(e))) throw e;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        throw new Error("backend never became ready");
      };
      const raw = window.otter;
      const o = {
        action: (name, value) => retry(() => raw.action(name, value)),
        call: (name, value) => retry(() => raw.call(name, value)),
      };
      const id = () => crypto.randomUUID();
      const soon = (minutes) => Date.now() + minutes * 60000;
      await o.action("assistant.create", {
        title: "喝水",
        dueAt: soon(23),
        kind: "reminder",
        requestId: id(),
      });
      await o.action("assistant.create", {
        title: "交周报",
        dueAt: soon(250),
        kind: "reminder",
        requestId: id(),
      });
      for (const title of ["回复 Kevin 的邮件", "打印头部支架", "标定舵机"])
        await o.action("assistant.todo-add", { title });
      const state = await o.action("assistant.get");
      await o.action("assistant.todo-toggle", state.todos[0].id);
      const robot = await o.call("projects.save", {
        name: "桌面机器人",
        goal: "让水獭能点头、左右看",
        links: [],
      });
      const draft = await o.call("projects.manual", { project_id: robot.id });
      const item = (kind, content) => ({
        id: id(),
        kind,
        content,
        source_ids: [],
      });
      await o.call("projects.commit", {
        draft_id: draft.id,
        items: [
          item("completed", "两个舵机都能识别，居中标定完成"),
          item("completed", "纸板头部原型搭好"),
          item("blocker", "支架孔位对不上，要 3D 打印"),
          item("next", "打印头部支架后试装"),
          item("next", "跑一遍点头、左右看预设"),
        ],
      });
      const memory = await o.call("memory.get");
      await o.call("memory.configure", {
        ...memory.settings,
        nickname: "小杨",
      });
    });
    // OTTER_UI_THEME=night (or mint, bay, system) shoots that theme.
    if (process.env.OTTER_UI_THEME)
      await panel.evaluate(
        (theme) => window.otter.action("theme", theme),
        process.env.OTTER_UI_THEME,
      );
    await panel.reload();
    await panel.waitForFunction(
      async () => !!(await window.otter.action("snapshot")).health,
    );
    const shoot = async (id, scroller) => {
      await panel.waitForTimeout(700);
      await panel.screenshot({ path: path.join(output, `${id}.png`) });
      // Only an inner column scrolls, so a full-page shot would show nothing new.
      await panel.evaluate((selector) => {
        const el = document.querySelector(selector);
        el.scrollTop = el.scrollHeight;
      }, scroller);
      await panel.waitForTimeout(250);
      await panel.screenshot({ path: path.join(output, `${id}-bottom.png`) });
    };
    if (states) await shootStates(panel, output, model.address().port);
    for (const [id, label] of PLACES) {
      if (only.length && !only.includes(id)) continue;
      await panel.getByRole("button", { name: label, exact: true }).click();
      await shoot(id, "main");
    }
    if (!only.length || only.some((id) => id.startsWith("settings"))) {
      await panel.getByRole("button", { name: "设置", exact: true }).click();
      for (const [id, label] of SETTINGS) {
        await panel
          .getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: label, exact: false })
          .click();
        await panel.waitForTimeout(600);
        await panel.screenshot({
          path: path.join(output, `settings-${id}.png`),
        });
      }
      await panel.keyboard.press("Escape");
    }
    await pet.screenshot({
      path: path.join(output, "desktop-pet.png"),
      omitBackground: true,
    });
    console.log(`screens in ${output}`);
  } finally {
    await app.close();
    model?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
