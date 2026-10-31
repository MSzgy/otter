// A desktop for trying the iPhone app against: the real app with throwaway
// data, a local stand-in model that streams slowly, the fake codex, and the
// phone link on (port 52531 so it never meets your own Otter). It writes the
// pairing link to <dir>/link.txt and then follows commands appended to
// <dir>/cmd, one per line:
//   todo <title> | done <title> | remind <minutes> <title> | focus <minutes>
//   chat <text> | codex <title>  (a slow task; 停 stops it) | theme <id>
//   control on|off (the phone may act or only look) | shot <png> | stats | stop
// Build first: npm run build. Usage: node scripts/mobile-demo.cjs [dir]
const { _electron: electron } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = path.resolve(process.argv[2] || "/tmp/otter-mobile-demo");
// OTTER_DEMO_KEEP=1 keeps the last run's data, so a paired phone stays paired.
const keep = process.env.OTTER_DEMO_KEEP === "1" && fs.existsSync(dir);
if (!keep) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const log = (...a) => {
  const line = a.join(" ");
  console.log(line);
  fs.appendFileSync(path.join(dir, "log.txt"), line + "\n");
};

function model() {
  return http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const body = JSON.parse(text || "{}");
      const first = body.messages?.[0]?.content || "";
      if (first.startsWith("[Otter")) {
        res.setHeader("Content-Type", "application/json");
        // The planner proposes a reminder for “…提醒我<事>”, nothing else.
        const ask = first.startsWith("[Otter task planner]")
          ? JSON.parse(body.messages[1].content)
          : null;
        // English too: the simulator's keyboard tool cannot type Chinese.
        const remind = ask && /(?:提醒我|remind me )(.+)$/i.exec(ask.text);
        const content = ask
          ? JSON.stringify(
              remind
                ? {
                    kind: "reminder_create",
                    title: remind[1],
                    when: {
                      at: new Date(Date.parse(ask.now) + 3600000).toISOString(),
                    },
                  }
                : { kind: "none" },
            )
          : first.includes("memory suggestion")
            ? '{"candidates":[]}'
            : '{"ids":[]}';
        return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }
      res.setHeader("Content-Type", "text/event-stream");
      const last = body.messages.at(-1);
      const user = [...body.messages].reverse().find((m) => m.role === "user");
      const codex = /^(让 Codex|codex )/i.exec(user?.content || "");
      if (codex && last.role !== "tool") {
        const call = {
          index: 0,
          id: "call_demo",
          function: {
            name: "agent_assign",
            arguments: JSON.stringify({
              agent: "codex",
              title: user.content.slice(8) || "检查项目",
              task: `慢慢做：${user.content}`,
              access: "read",
            }),
          },
        };
        return res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
      }
      const answer =
        last.role === "tool"
          ? "好的，已经交给 Codex 了，做完它的结果会自动发回来。"
          : `收到：「${user?.content}」。我在 Mac 上，这句话一个字一个字地流到你的手机上，看看是不是几乎同时出现。水獭今天心情不错，**记得喝水**。`;
      const chars = [...answer];
      let i = 0;
      const tick = setInterval(() => {
        const piece = chars.slice(i, i + 2).join("");
        i += 2;
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
        );
        if (i >= chars.length) {
          clearInterval(tick);
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          );
        }
      }, 60);
      res.on("close", () => clearInterval(tick));
    });
  });
}

(async () => {
  const fake = model();
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const userData = path.join(dir, "user");
  const project = path.join(dir, "project");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  if (!keep)
    fs.writeFileSync(
      path.join(userData, "desktop.json"),
      JSON.stringify({
        quiet: true,
        body: { enabled: false },
        ambient: { enabled: false },
        shortcuts: { enabled: false },
        agents: { defaultFolder: project, tasks: [] },
      }),
    );
  const config = path.join(dir, "config.toml");
  fs.writeFileSync(
    config,
    '[core]\ntimezone = "Asia/Shanghai"\n[identity]\nprimary = "demo@otter.local"\n[llm]\nprovider = "mock"\n[llm.mock]\nresponse = "# 简报"\n',
  );
  const fakeCodex = path.resolve(__dirname, "fake-codex.cjs");
  fs.chmodSync(fakeCodex, 0o755);
  const app = await electron.launch({
    args: [path.resolve(__dirname, "..")],
    env: {
      ...process.env,
      OTTER_DESKTOP_USER_DATA: userData,
      OTTER_DESKTOP_CONFIG: config,
      OTTER_PROJECT_ROOT: dir,
      OTTER_MOBILE_PORT: "52531",
      OTTER_MOBILE_LOG: path.join(dir, "link.log"),
      OTTER_CODEX_BIN: fakeCodex,
      OTTER_TEST_NO_TERMINAL: "1",
    },
  });
  let panel;
  for (let i = 0; i < 100 && !panel; i++) {
    panel = app.windows().find((w) => w.url().includes("view=panel"));
    await new Promise((r) => setTimeout(r, 100));
  }
  await panel.waitForFunction(
    async () => !!(await window.otter.action("snapshot")).health,
    {},
    { timeout: 30000 },
  );
  // The backend may still be settling right after health comes back.
  await panel.evaluate(async (port) => {
    for (let i = 0; ; i++)
      try {
        await window.otter.call("health.get");
        break;
      } catch (e) {
        if (i > 40) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    await window.otter.call("models.save", {
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "demo",
      api_key: "",
      use_api_key: false,
      max_tokens: 1024,
      timeout_sec: 30,
      token_limit_field: "max_tokens",
    });
    await window.otter.action("reconnect");
  }, fake.address().port);
  await panel.waitForFunction(
    async () =>
      (await window.otter.action("snapshot")).health?.provider === "openai",
    {},
    { timeout: 30000 },
  );
  const act = (name, value) =>
    panel.evaluate(([n, v]) => window.otter.action(n, v), [name, value]);
  if (!keep) {
    await act("assistant.todo-add", { title: "给舵机换新的齿轮" });
    await act("assistant.todo-add", { title: "打印头部支架" });
    await act("assistant.create", {
      title: "喝杯水",
      dueAt: Date.now() + 40 * 60000,
      kind: "once",
      requestId: crypto.randomUUID(),
    });
  }
  await act("mobile.enable", true);
  const mobile = await act("mobile.pair");
  fs.writeFileSync(path.join(dir, "link.txt"), mobile.pairing.link);
  log(`ready: pairing link in ${path.join(dir, "link.txt")}`);
  fs.writeFileSync(path.join(dir, "cmd"), "");
  let done = 0;
  const chatInput = panel.getByRole("textbox", { name: "聊天输入" });
  for (;;) {
    await new Promise((r) => setTimeout(r, 200));
    const lines = fs.readFileSync(path.join(dir, "cmd"), "utf8").split("\n");
    for (const line of lines.slice(done, -1)) {
      done++;
      const [verb, ...rest] = line.trim().split(" ");
      const text = rest.join(" ");
      try {
        if (verb === "todo") await act("assistant.todo-add", { title: text });
        if (verb === "done") {
          const todo = (await act("assistant.get")).todos.find(
            (t) => t.title === text,
          );
          await act("assistant.todo-toggle", todo.id);
        }
        if (verb === "remind")
          await act("assistant.create", {
            title: rest.slice(1).join(" "),
            dueAt: Date.now() + Number(rest[0]) * 60000,
            kind: "once",
            requestId: crypto.randomUUID(),
          });
        if (verb === "focus")
          await act("assistant.create", {
            title: "专注结束",
            dueAt: Date.now() + Number(text) * 60000,
            kind: "focus",
            requestId: crypto.randomUUID(),
          });
        if (verb === "chat" || verb === "codex") {
          await panel
            .getByRole("button", { name: "聊天", exact: true })
            .first()
            .click();
          await chatInput.fill(verb === "codex" ? `让 Codex ${text}` : text);
          await panel
            .getByRole("button", { name: "发送", exact: true })
            .click();
          if (verb === "codex") {
            await panel
              .getByRole("button", { name: "允许一次", exact: true })
              .click({ timeout: 15000 });
          }
        }
        if (verb === "停") {
          const running = (await act("agents.get")).tasks.find(
            (t) => t.status === "running",
          );
          if (running) await act("agents.stop", { id: running.id });
        }
        if (verb === "theme") await act("theme", text);
        if (verb === "shot") {
          await panel
            .getByRole("button", { name: "聊天", exact: true })
            .first()
            .click();
          await panel.waitForTimeout(500);
          await panel.screenshot({ path: text });
        }
        if (verb === "control") {
          const [device] = (await act("mobile.get")).devices;
          await act("mobile.control", {
            id: device.id,
            control: text === "on",
          });
        }
        if (verb === "stats")
          log(JSON.stringify((await act("mobile.get")).devices));
        if (verb === "stop") {
          await app.close();
          fake.close();
          process.exit(0);
        }
        log(`done: ${line}`);
      } catch (e) {
        log(`failed: ${line}: ${e.message}`);
      }
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
