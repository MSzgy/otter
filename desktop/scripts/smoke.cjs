// Electron needs Playwright's Electron launcher rather than a browser-only CLI.
const { _electron: electron } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const http = require("node:http");
const { projectModelReply, verifyProjects } = require("./project-smoke.cjs");
const { verifyHandoff } = require("./handoff-smoke.cjs");
const { go, openScenes, openTools } = require("./smoke-nav.cjs");
const { startFakeHttpMcp } = require("./fake-mcp-http.cjs");
const { startSshd } = require("./local-sshd.cjs");
const { extractPage } = require("../electron/page-reader.cjs");
const { nativeRead } = require("../electron/awareness.cjs");
const { execFileSync } = require("node:child_process");
(async () => {
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "otter-desktop-smoke-"),
  );
  const output = path.resolve(__dirname, "../../output/playwright");
  // A stand-in home folder with other tools' skills: a shared one that
  // Claude Code links to, one only Claude Code has, one only Codex has, and
  // a hidden system folder that is skipped.
  const skillsHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "otter-skills-home-"),
  );
  const homeSkill = (folder, name) => {
    fs.mkdirSync(path.join(skillsHome, folder, name), { recursive: true });
    fs.writeFileSync(
      path.join(skillsHome, folder, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} 的用法\n---\n做法\n`,
    );
  };
  // 背景图片: real pictures made with sips from macOS's own wallpapers (a
  // PNG for the settings picker, which reads whatever sits at backdropPick
  // since the test cannot drive the open panel, and a large HEIC for chat).
  const backdropDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "otter-backdrop-smoke-"),
  );
  const wallpaper = (name) =>
    [
      `/System/Library/Desktop Pictures/${name}`,
      "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/FinderIcon.icns",
    ].find((f) => fs.existsSync(f));
  const backdropPick = path.join(backdropDir, "橘子海.png");
  execFileSync(
    "/usr/bin/sips",
    [
      "-s",
      "format",
      "png",
      "-Z",
      "1200",
      wallpaper("iMac Orange.heic"),
      "--out",
      backdropPick,
    ],
    { stdio: "pipe" },
  );
  const backdropHeic = wallpaper("Sonoma.heic");
  // SSH: a real sshd for key logins, a stand-in home with ~/.ssh/config, and
  // a scratch keychain, so no test password touches the user's own.
  const sshd = await startSshd();
  const sshHome = fs.mkdtempSync(path.join(os.tmpdir(), "otter-ssh-home-"));
  fs.mkdirSync(path.join(sshHome, ".ssh"));
  fs.writeFileSync(
    path.join(sshHome, ".ssh", "config"),
    "Host lab\n  HostName lab.example.com\n  User ops\n",
  );
  const keychains = () =>
    execFileSync("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
    ]).toString();
  const keychainsBefore = keychains();
  const sshKeychain = path.join(
    os.tmpdir(),
    `otter-smoke-${process.pid}.keychain-db`,
  );
  execFileSync("/usr/bin/security", [
    "create-keychain",
    "-p",
    "smoke",
    sshKeychain,
  ]);
  execFileSync("/usr/bin/security", [
    "unlock-keychain",
    "-p",
    "smoke",
    sshKeychain,
  ]);
  homeSkill(".agents/skills", "shared-tips");
  homeSkill(".claude/skills", "claude-notes");
  homeSkill(".codex/skills", "codex-helper");
  homeSkill(".codex/skills/.system", "hidden-system");
  fs.symlinkSync(
    path.join(skillsHome, ".agents/skills/shared-tips"),
    path.join(skillsHome, ".claude/skills/shared-tips"),
  );
  fs.mkdirSync(output, { recursive: true });
  const requests = [];
  const memoryRequests = [];
  const taskRequests = [];
  const projectRequests = [];
  let openedLink = 0;
  const lastUserOf = (body) =>
    [...(body.messages || [])].reverse().find((m) => m.role === "user")
      ?.content || "";
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/action-target") {
      openedLink++;
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<title>Otter test</title><p>Otter link-opening verification. This test tab can be closed.</p>",
      );
      return;
    }
    if (req.method === "GET" && req.url !== "/article") {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/article") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><title>Fixture article</title><article><h1>Test title</h1><p>Visible article body</p><div hidden>hidden secret</div><div style="opacity:0">transparent secret</div><textarea>form secret</textarea><div contenteditable="true">editable secret</div></article>',
      );
      return;
    }
    if (req.url === "/v1/audio/transcriptions") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        assert(body.includes(Buffer.from("whisper-1")));
        assert(body.includes(Buffer.from("recording.webm")));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ text: "这是测试语音转写" }));
      });
      return;
    }
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      const body = JSON.parse(text);
      const memoryPurpose = body.messages?.[0]?.content || "";
      if (memoryPurpose.startsWith("[Otter project snapshot]")) {
        const payload = JSON.parse(body.messages[1].content);
        projectRequests.push(payload);
        const content = JSON.stringify(
          projectModelReply("[Otter project snapshot]", payload),
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      if (memoryPurpose.startsWith("[Otter task planner]")) {
        const payload = JSON.parse(body.messages[1].content);
        taskRequests.push(payload);
        const projectPlan = projectModelReply("task", payload);
        if (projectPlan) {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(projectPlan) } }],
            }),
          );
          return;
        }

        const request = payload.text;
        let plan = { kind: "none" };
        const recent = payload.tasks.recent_target;
        if (request === "明天上午十点提醒我检查机器人") {
          const day = new Intl.DateTimeFormat("en-CA", {
            timeZone: payload.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(Date.parse(payload.now) + 86400000));
          plan = {
            kind: "reminder_create",
            title: "检查机器人",
            when: { at: `${day}T10:00:00+08:00` },
          };
        } else if (request === "把刚才那个提醒推迟半小时") {
          plan = {
            kind: "reminder_update",
            id: recent.id,
            when: { shift_seconds: 1800 },
          };
        } else if (request === "取消刚才那个提醒") {
          plan = { kind: "reminder_cancel", id: recent.id };
        } else if (request === "看看我有哪些提醒") {
          plan = { kind: "reminder_list", status: "active" };
        } else if (request === "记个待办：测试机器人动作") {
          plan = { kind: "todo_add", title: "测试机器人动作" };
        } else if (request === "刚才的待办完成了") {
          plan = { kind: "todo_complete", id: recent.id };
        } else if (request === "查看已完成待办") {
          plan = { kind: "todo_list", status: "done" };
        } else if (request === "帮我提醒一下") {
          plan = { kind: "clarify", message: "请告诉我提醒的具体时间和内容。" };
        } else if (request === "换成夜里小窝主题") {
          plan = { kind: "setting_change", id: "theme", value: "night" };
        } else if (request.startsWith("背景换成 ")) {
          plan = {
            kind: "setting_change",
            id: "backdrop.image",
            value: request.slice("背景换成 ".length),
          };
        } else if (request === "背景换成海边那张") {
          plan = {
            kind: "setting_change",
            id: "backdrop.image",
            value: "~/Pictures/海边.jpg",
          };
        } else if (request === "背景图透明度调到 80") {
          plan = {
            kind: "setting_change",
            id: "backdrop.transparency",
            value: 80,
          };
        } else if (request === "安静模式现在开着吗") {
          plan = { kind: "setting_query", id: "quiet" };
        } else if (request === "把模型密钥改成 abc") {
          plan = { kind: "setting_change", id: "models.api_key", value: "abc" };
        } else if (request.startsWith("保存服务器 box")) {
          plan = {
            kind: "ssh_save",
            server: {
              name: "box",
              host: "127.0.0.1",
              user: sshd.user,
              port: sshd.port,
              auth: "key",
              key_path: sshd.key,
            },
          };
        } else if (request.startsWith("保存服务器 pwbox")) {
          plan = {
            kind: "ssh_save",
            server: {
              name: "pwbox",
              host: "10.9.8.7",
              user: "me",
              auth: "password",
            },
          };
        } else if (request === "打开计算器") {
          plan = { kind: "open_app", target: "com.apple.calculator" };
        } else if (request.startsWith("打开这个网页 http://127.0.0.1:")) {
          plan = {
            kind: "open_url",
            target: request.slice("打开这个网页 ".length),
          };
        } else if (request === "取消分析测试") {
          setTimeout(() => {
            if (!res.destroyed)
              res.end(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          kind: "todo_add",
                          title: "不应出现",
                        }),
                      },
                    },
                  ],
                }),
              );
          }, 600);
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    request === "办事格式故障测试"
                      ? "not JSON"
                      : JSON.stringify(plan),
                },
              },
            ],
          }),
        );
        return;
      }
      if (
        memoryPurpose.startsWith("[Otter memory suggestion]") ||
        memoryPurpose.startsWith("[Otter semantic memory lookup]")
      ) {
        const payload = JSON.parse(body.messages[1].content);
        memoryRequests.push({ purpose: memoryPurpose, payload });
        let content;
        if (memoryPurpose.startsWith("[Otter memory suggestion]")) {
          const fact = payload.user_text.includes("我家猫叫糯米")
            ? {
                title: "糯米",
                content: "我家猫叫糯米，它三岁了。",
                category: "fact",
                evidence: "我家猫叫糯米",
              }
            : payload.user_text.includes("我喜欢提前规划旅行")
              ? {
                  title: "旅行偏好",
                  content: "我喜欢提前规划旅行",
                  category: "preference",
                  evidence: "我喜欢提前规划旅行",
                }
              : null;
          content = JSON.stringify({ candidates: fact ? [fact] : [] });
        } else {
          content =
            payload.query === "本次语义故障测试"
              ? "not JSON"
              : JSON.stringify({
                  ids: payload.memories
                    .filter(
                      (m) =>
                        m.content.includes("糯米") || m.category === "project",
                    )
                    .map((m) => m.id),
                });
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      requests.push({ url: req.url, body, auth: req.headers.authorization });
      res.setHeader("Content-Type", "application/json");
      const lastUser =
        [...(body.messages || [])].reverse().find((m) => m.role === "user")
          ?.content || "";
      if (body.stream && lastUser.startsWith("在 box 上看看")) {
        res.setHeader("Content-Type", "text/event-stream");
        const result = body.messages.find((m) => m.role === "tool");
        const chunk = result
          ? {
              choices: [
                {
                  delta: { content: `命令结果：${result.content}` },
                  finish_reason: "stop",
                },
              ],
            }
          : {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_ssh",
                        function: {
                          name: "ssh_run",
                          arguments: JSON.stringify({
                            server: "box",
                            command: "echo smoke-$(whoami)",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.stream && lastUser.startsWith("用 skill 帮我添加")) {
        // Read the add-mcp-server skill, then propose a server, then report.
        res.setHeader("Content-Type", "text/event-stream");
        const results = body.messages.filter((m) => m.role === "tool");
        const call = (name, args) => ({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${results.length}`,
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
        const chunk =
          results.length === 0
            ? call("use_skill", { name: "add-mcp-server" })
            : results.length === 1
              ? call("otter_add_mcp_server", {
                  config: {
                    mcpServers: {
                      viatool: {
                        command: process.execPath,
                        args: [path.join(__dirname, "fake-mcp-server.cjs")],
                      },
                    },
                  },
                })
              : {
                  choices: [
                    {
                      delta: { content: `添加结果：${results.at(-1).content}` },
                      finish_reason: "stop",
                    },
                  ],
                };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.stream && lastUser.startsWith("用 skill 写俳句")) {
        res.setHeader("Content-Type", "text/event-stream");
        const result = body.messages.find((m) => m.role === "tool");
        const chunk = result
          ? {
              choices: [
                {
                  delta: {
                    content: `照着 skill：${result.content.includes("第三行写水獭") ? "已读" : "没读到"}`,
                  },
                  finish_reason: "stop",
                },
              ],
            }
          : {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_skill",
                        function: {
                          name: "use_skill",
                          arguments: JSON.stringify({ name: "otter-haiku" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.stream && lastUser.startsWith("读一下这个网页")) {
        // Ask to read a page on this Mac, then report what came back.
        res.setHeader("Content-Type", "text/event-stream");
        const result = body.messages.find((m) => m.role === "tool");
        const chunk = result
          ? {
              choices: [
                {
                  delta: { content: `网页结果：${result.content}` },
                  finish_reason: "stop",
                },
              ],
            }
          : {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_web",
                        function: {
                          name: "otter_read_webpage",
                          arguments: JSON.stringify({
                            url: lastUser.slice("读一下这个网页".length).trim(),
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return;
      }
      const noteTool = [
        ["用笔记工具记下", "mcp__fake__add_note"],
        ["用远程笔记记下", "mcp__cloud__add_note"],
      ].find(([prefix]) => lastUser.startsWith(prefix));
      if (body.stream && noteTool) {
        // Ask the MCP server's add_note, then report what came back.
        res.setHeader("Content-Type", "text/event-stream");
        const result = body.messages.find((m) => m.role === "tool");
        const note = lastUser.slice(noteTool[0].length).trim();
        const chunk = result
          ? {
              choices: [
                {
                  delta: { content: `工具结果：${result.content}` },
                  finish_reason: "stop",
                },
              ],
            }
          : {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_note",
                        function: {
                          name: noteTool[1],
                          arguments: JSON.stringify({ text: note }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.stream && lastUser.startsWith("用工具看看现在几点")) {
        // First ask for otter_time, then answer with what it returned.
        res.setHeader("Content-Type", "text/event-stream");
        const result = body.messages.find((m) => m.role === "tool");
        const chunk = result
          ? {
              choices: [
                {
                  delta: { content: `按 Otter 的时钟：${result.content}` },
                  finish_reason: "stop",
                },
              ],
            }
          : {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_time",
                        function: { name: "otter_time", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return;
      }
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
      env: {
        ...process.env,
        OTTER_DESKTOP_USER_DATA: userData,
        OTTER_SKILLS_HOME: skillsHome,
        OTTER_SSH_HOME: sshHome,
        OTTER_SSH_KEYCHAIN: sshKeychain,
        OTTER_TEST_NO_TERMINAL: "1",
        OTTER_TEST_BACKDROP_PICK: backdropPick,
      },
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
    await panel.waitForFunction(() => !!window.otter);

    const readerPromise = app.waitForEvent("window");
    const readerHandle = await app.evaluateHandle(
      ({ BrowserWindow }, url) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
          },
        });
        void win.loadURL(url);
        return win;
      },
      apiUrl.replace("/v1", "/article"),
    );
    const reader = await readerPromise;
    await reader
      .getByText("Visible article body", { exact: true })
      .waitFor({ state: "attached" });
    const extracted = JSON.parse(await reader.evaluate(extractPage));
    assert(extracted.text.includes("Visible article body"));
    assert(!extracted.text.includes("secret"));
    await readerHandle.evaluate((win) => win.destroy());

    panel.on("pageerror", (e) => errors.push(e.message));
    pet.on("pageerror", (e) => errors.push(e.message));
    console.log(await panel.locator("body").ariaSnapshot());
    await panel
      .getByText("离线演示模式", { exact: true })
      .waitFor({ timeout: 30000 });
    await panel.evaluate(() =>
      window.otter.call("memory.ai-configure", {
        suggestions: false,
        semantic: false,
      }),
    );
    await go(panel, "应用感知");
    await panel
      .getByRole("heading", { name: "感知已关闭", exact: true })
      .waitFor();
    await panel
      .getByRole("checkbox", { name: "开启应用感知", exact: true })
      .click();
    await panel.waitForFunction(
      () => document.querySelectorAll(".app-content-list article").length > 0,
    );
    const observed = await panel.evaluate(() =>
      window.otter.action("awareness.get"),
    );
    assert(observed.apps.length > 0 && observed.front);
    assert.equal(observed.browserEnabled, false);
    assert.equal(observed.browser, null);
    const contentPermissions = await panel.evaluate(() =>
      window.otter.action("awareness.content-permissions"),
    );
    assert.equal(typeof contentPermissions.accessibility, "boolean");
    assert.equal(typeof contentPermissions.screenRecording, "boolean");
    const ownPid = await app.evaluate(() => process.pid);
    const ownApp = observed.apps.find((a) => a.pid === ownPid);
    if (ownApp) {
      const row = panel.locator(`[data-app-pid="${ownPid}"]`);
      await row
        .getByRole("button", { name: "读取窗口文字", exact: true })
        .click();
      await panel.locator(".application-text-result").waitFor();
      if (!contentPermissions.accessibility)
        await panel.getByText(/当前 Otter 尚未获得对应系统权限/).waitFor();
    }

    if (process.env.OTTER_TEST_WINDOW_OCR === "1") {
      assert(ownApp, "Isolated test app must be present in awareness list");
      assert(
        contentPermissions.screenRecording,
        "Otter needs screen recording permission for real window OCR",
      );
      await panel.evaluate(() => {
        const marker = document.createElement("div");
        marker.id = "otter-ocr-fixture";
        marker.textContent = "OTTER WINDOW CONTENT CHECK";
        marker.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;background:white;color:black;font:48px Arial;display:flex;align-items:center;justify-content:center";
        document.body.append(marker);
      });
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("view=panel"),
        );
        window.show();
        window.focus();
      });
      await panel.bringToFront();
      await panel.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await panel.screenshot(); // Wait for the fixture to be painted; do not save it.
      try {
        const captured = await panel.evaluate(
          (target) =>
            window.otter.action("awareness.content", {
              pid: target.pid,
              bundleId: target.bundleId,
              method: "ocr",
            }),
          ownApp,
        );
        assert.equal(
          captured.status,
          "ready",
          JSON.stringify({
            status: captured.status,
            permission: captured.permission,
            windows: captured.windows.map((w) => ({
              title: w.title,
              length: w.text.length,
            })),
          }),
        );
        assert(
          captured.windows.some((w) =>
            /OTTER WINDOW CONTENT CHECK/.test(w.text),
          ),
          "Native OCR must recognize the visible test marker",
        );
        console.log(
          "PASS: native capture and Vision OCR recognized isolated Otter window marker",
        );
      } finally {
        await panel.evaluate(() =>
          document.getElementById("otter-ocr-fixture")?.remove(),
        );
      }
    }

    const requestsBeforePreview = requests.length;
    await panel
      .getByRole("button", { name: "聊聊当前场景", exact: true })
      .click();
    await panel
      .getByRole("textbox", { name: "附带上下文", exact: true })
      .waitFor();
    assert.equal(requests.length, requestsBeforePreview);
    await panel.getByRole("button", { name: "移除附件", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "附带上下文", exact: true })
      .waitFor({ state: "detached" });
    await go(panel, "应用感知");
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
    const disabledAwareness = await panel.evaluate(() =>
      window.otter.action("awareness.get"),
    );
    const browserFixture = {
      ...disabledAwareness,
      enabled: true,
      browserEnabled: true,
      status: "ready",
      browserStatus: "ready",
      supportedBrowsers: { "com.google.Chrome": "Google Chrome" },
      apps: [
        {
          name: "Google Chrome",
          bundleId: "com.google.Chrome",
          pid: 91001,
          path: "/Applications/Google Chrome.app",
        },
        {
          name: "Google Chrome",
          bundleId: "com.google.Chrome",
          pid: 91002,
          path: "/Volumes/Google Chrome/Google Chrome.app",
        },
      ],
      tabs: [
        {
          name: "Google Chrome",
          bundleId: "com.google.Chrome",
          pid: 91001,
          windowId: "1",
          tabId: "1",
          windowIndex: 1,
          title: "Otter 阅读测试文章",
          url: "https://example.com/",
          active: true,
        },
      ],
      tabWindowCount: 1,
      browser: null,
    };
    // Native polling is off: only fixed fixture data is rendered here.
    const publishAwareness = async (data) =>
      app.evaluate(({ BrowserWindow }, state) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("view=panel"),
        );
        window.webContents.send("otter:event", {
          type: "awareness.changed",
          data: state,
        });
      }, data);
    await publishAwareness(browserFixture);
    const picker = panel.getByRole("combobox", {
      name: "选择浏览器",
      exact: true,
    });
    await picker.waitFor();
    assert.equal(await picker.inputValue(), "91001");
    assert.equal(
      await panel
        .getByRole("button", { name: "刷新标签页", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await panel.getByRole("button", { name: /当前网页|实例/ }).count(),
      0,
    );
    assert(!(await panel.locator("body").innerText()).includes("91001"));
    await picker.selectOption("91002");
    assert.equal(
      await panel
        .getByRole("button", { name: "读取此页正文", exact: true })
        .count(),
      0,
    );
    await picker.selectOption("91001");
    await panel.getByText("Otter 阅读测试文章", { exact: true }).waitFor();
    await panel.screenshot({
      path: path.join(output, "otter-browser-picker.png"),
    });
    await publishAwareness(disabledAwareness);

    await go(panel, "陪伴互动");
    await panel.getByRole("heading", { name: "我的水獭" }).waitFor();
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
    await go(panel, "工作简报");
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
    await go(panel, "偏好设置");
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
    await go(panel, "工作简报");
    await panel
      .getByRole("heading", { name: "欢迎来到 Otter" })
      .waitFor({ timeout: 30000 });
    await go(panel, "偏好设置");
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
    await go(panel, "工作简报");
    await panel.getByRole("button", { name: "生成简报", exact: true }).click();
    await panel
      .getByRole("heading", { name: "OpenAI 兼容接口测试成功", exact: true })
      .waitFor({ timeout: 30000 });
    await go(panel, "与水獭聊天");
    await go(panel, "应用感知");
    await panel
      .getByRole("checkbox", { name: "开启应用感知", exact: true })
      .click();
    await panel.waitForFunction(
      () => document.querySelectorAll(".app-content-list article").length > 0,
    );
    await panel
      .getByRole("button", { name: "聊聊当前场景", exact: true })
      .click();
    await panel
      .getByRole("textbox", { name: "附带上下文", exact: true })
      .fill("来源：测试选区；内容：hello context");
    await panel.screenshot({
      path: path.join(output, "otter-context-preview.png"),
    });
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
    await panel.evaluate(() => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async () => {
          await context.resume();
          return destination.stream;
        },
      });
      window.__testAudio = { context, oscillator };
    });
    const voiceButton = panel.getByRole("button", {
      name: "按住说话",
      exact: true,
    });
    await voiceButton.scrollIntoViewIfNeeded();
    const voiceBox = await voiceButton.boundingBox();
    await panel.mouse.move(
      voiceBox.x + voiceBox.width / 2,
      voiceBox.y + voiceBox.height / 2,
    );
    await panel.mouse.down();
    await panel.getByText("正在录音，松开转写", { exact: true }).waitFor();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await panel.mouse.up();
    await panel.waitForFunction(
      () =>
        document.querySelector('[aria-label="聊天输入"]').value ===
        "这是测试语音转写",
    );
    await panel
      .getByRole("textbox", { name: "聊天输入", exact: true })
      .fill("");
    await panel.evaluate(() => {
      window.__testAudio.oscillator.stop();
      return window.__testAudio.context.close();
    });
    assert.equal(fs.readdirSync(path.join(userData, "audio-temp")).length, 0);
    const chatCalls = requests.filter((r) => r.body.stream);
    assert.deepEqual(
      chatCalls[1].body.messages.map((m) => m.role),
      ["system", "user", "assistant", "user"],
    );
    assert(chatCalls[1].body.messages[1].content.startsWith("你好小水獭"));
    assert(chatCalls[0].body.messages[1].content.includes("测试选区"));
    assert.equal(
      await panel
        .getByRole("textbox", { name: "附带上下文", exact: true })
        .count(),
      0,
    );
    await panel.screenshot({ path: path.join(output, "otter-chat.png") });
    await go(panel, "偏好设置");
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
    await panel.evaluate(() =>
      window.otter.call("memory.ai-configure", {
        suggestions: false,
        semantic: false,
      }),
    );
    // Memory: explicit save without a model call, recall, correction, undo.
    const chatSay = async (text) => {
      const count = await panel.locator(".chat-message.assistant").count();
      await panel.getByRole("textbox", { name: "聊天输入" }).fill(text);
      await panel.getByRole("button", { name: "发送", exact: true }).click();
      await panel.waitForFunction(
        (n) =>
          document.querySelectorAll(".chat-message.assistant").length ===
            n + 1 && !document.querySelector(".chat-cursor"),
        count,
      );
    };
    // Tools: the chat offers Otter's look-ups, runs the one the model asks for
    // without a card (read-only), and shows it under the reply.
    await chatSay("用工具看看现在几点");
    const toolTurns = requests.filter(
      (r) =>
        r.body.stream && lastUserOf(r.body).startsWith("用工具看看现在几点"),
    );
    assert.equal(toolTurns.length, 2, "Asked once, answered after the tool");
    assert.deepEqual(
      toolTurns[0].body.tools.map((t) => t.function.name),
      [
        "otter_read_webpage",
        "otter_add_mcp_server",
        "otter_time",
        "otter_reminders",
        "otter_todos",
        "otter_settings",
        // The add-mcp-server skill ships with the app.
        "use_skill",
        "read_skill_file",
        // ~/.ssh/config has a host, so the server tools are offered.
        "ssh_list_servers",
        "ssh_open_terminal",
        "ssh_run",
      ],
    );
    assert.equal(toolTurns[1].body.messages.at(-1).role, "tool");
    await panel
      .locator(".chat-message.assistant")
      .last()
      .getByText("✓ 看时间")
      .waitFor();
    await panel
      .locator(".chat-message.assistant")
      .last()
      .getByText(/按 Otter 的时钟：.*（Asia\/Shanghai）/)
      .waitFor();
    // Reading a web page asks first and shows the address; addresses on this
    // Mac or the local network are refused even after 允许.
    const pageUrl = apiUrl.replace("/v1", "/article");
    await panel
      .getByRole("textbox", { name: "聊天输入" })
      .fill(`读一下这个网页 ${pageUrl}`);
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    const webCard = panel.getByRole("region", { name: "工具请求：读网页" });
    await webCard.getByText(pageUrl, { exact: false }).waitFor();
    await webCard
      .getByRole("button", { name: "允许一次", exact: true })
      .click();
    await panel
      .getByText(/网页结果：工具出错：不能读取本机或局域网里的地址/)
      .waitFor();
    await panel
      .locator(".chat-message.assistant")
      .last()
      .getByText("✕ 读网页")
      .waitFor();
    // MCP: a server added in settings offers its tools; a call that writes
    // waits for the card, and only 允许 lets it run.
    const notesFile = path.join(
      os.tmpdir(),
      `otter-mcp-notes-${process.pid}.txt`,
    );
    fs.rmSync(notesFile, { force: true });
    const notes = () =>
      fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : "";
    const openTools = async () => {
      if (!(await panel.getByRole("dialog", { name: "设置" }).isVisible()))
        await panel.getByRole("button", { name: "设置", exact: true }).click();
      await panel
        .getByRole("navigation", { name: "设置分组" })
        .getByRole("button", { name: "工具与扩展" })
        .click();
    };
    await openTools();
    await panel.getByRole("textbox", { name: "MCP 配置" }).fill(
      JSON.stringify({
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [path.join(__dirname, "fake-mcp-server.cjs")],
            env: { NOTES_FILE: notesFile },
          },
        },
      }),
    );
    await panel.getByRole("button", { name: "检查配置", exact: true }).click();
    await panel.getByText(/这会在你的 Mac 上运行下面的命令/).waitFor();
    await panel.getByRole("button", { name: "确认添加", exact: true }).click();
    await panel.getByText("运行中 · 2 个工具", { exact: true }).waitFor();
    await panel.screenshot({
      path: path.join(output, "otter-mcp-settings.png"),
    });
    await panel.keyboard.press("Escape");
    const noteSay = async (text) => {
      await panel.getByRole("textbox", { name: "聊天输入" }).fill(text);
      await panel.getByRole("button", { name: "发送", exact: true }).click();
    };
    const card = panel.getByRole("region", { name: "工具请求：记一条笔记" });
    await noteSay("用笔记工具记下 买牛奶");
    await card.getByText(/"text": "买牛奶"/).waitFor();
    assert.equal(notes(), "", "Nothing runs before 允许");
    assert(
      requests
        .at(-1)
        .body.tools.some((t) => t.function.name === "mcp__fake__add_note"),
    );
    await panel.screenshot({ path: path.join(output, "otter-mcp-card.png") });
    await card.getByRole("button", { name: "允许一次", exact: true }).click();
    await panel
      .getByText("工具结果：记下了：买牛奶", { exact: true })
      .waitFor();
    assert.equal(notes(), "买牛奶\n");
    await noteSay("用笔记工具记下 第二条");
    await card.getByRole("button", { name: "拒绝", exact: true }).click();
    await panel.getByText(/工具结果：用户没有允许这次调用/).waitFor();
    await panel
      .locator(".chat-message.assistant")
      .last()
      .getByText("✕ 记一条笔记")
      .waitFor();
    assert.equal(notes(), "买牛奶\n", "A refused call does not run");
    await openTools();
    await panel.getByText("它的工具 · 2").click();
    await panel
      .getByRole("checkbox", { name: "记一条笔记 不用再问", exact: true })
      .check();
    await panel.keyboard.press("Escape");
    await noteSay("用笔记工具记下 第三条");
    await panel
      .getByText("工具结果：记下了：第三条", { exact: true })
      .waitFor();
    assert.equal(notes(), "买牛奶\n第三条\n", "不用再问 runs without a card");
    await openTools();
    await panel
      .getByRole("checkbox", { name: "启用 fake", exact: true })
      .uncheck();
    await panel
      .getByRole("article", { name: "MCP 服务：fake" })
      .getByText("已关闭", { exact: true })
      .waitFor();
    await panel.getByRole("button", { name: "删除 fake", exact: true }).click();
    await panel.getByRole("button", { name: "确认删除", exact: true }).click();
    await panel.getByText("还没有接上 MCP 服务。").waitFor();
    await panel.keyboard.press("Escape");
    fs.rmSync(notesFile, { force: true });
    // MCP from chat: a pasted config becomes a card that names the command;
    // a remote server (streamable HTTP, with a token) the same, then its tool
    // is used like any other, after 允许.
    const pasted = JSON.stringify({
      mcpServers: {
        chatnotes: {
          command: process.execPath,
          args: [path.join(__dirname, "fake-mcp-server.cjs")],
        },
      },
    });
    await noteSay(`帮我接上这个 MCP：${pasted}`);
    const addCard = panel.getByRole("region", { name: "办事确认" });
    await addCard.getByText("确认添加 MCP 服务").waitFor();
    await addCard.getByText(/chatnotes：运行 .*fake-mcp-server\.cjs/).waitFor();
    await addCard
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await panel.getByText(/^已添加 MCP 服务：chatnotes/).waitFor();
    const remoteNotes = path.join(
      os.tmpdir(),
      `otter-remote-notes-${process.pid}.txt`,
    );
    fs.rmSync(remoteNotes, { force: true });
    const remote = await startFakeHttpMcp({
      token: "smoke-token",
      notesFile: remoteNotes,
    });
    try {
      await noteSay(
        `接上远程 MCP ${JSON.stringify({ mcpServers: { cloud: { url: remote.url, headers: { Authorization: "Bearer smoke-token" } } } })}`,
      );
      await addCard
        .getByText(`cloud：连接 ${remote.url}（请求头：Authorization）`)
        .waitFor();
      assert(
        !(await addCard.innerText()).includes("smoke-token"),
        "The card never shows a header value",
      );
      await panel.screenshot({
        path: path.join(output, "otter-mcp-add-from-chat.png"),
      });
      await addCard
        .getByRole("button", { name: "确认执行", exact: true })
        .click();
      await panel.getByText(/^已添加 MCP 服务：cloud/).waitFor();
      const kept = await panel.evaluate(async () => {
        const [latest] = await window.otter.call("chat.sessions", {});
        return JSON.stringify(
          await window.otter.call("chat.history", { session_id: latest.id }),
        );
      });
      assert(kept.includes("接上远程 MCP"), "The request itself is kept");
      assert(!kept.includes("smoke-token"), "but never the token");
      await openTools();
      await panel
        .getByRole("article", { name: "MCP 服务：cloud" })
        .getByText("运行中 · 2 个工具", { exact: true })
        .waitFor();
      await panel
        .getByRole("article", { name: "MCP 服务：cloud" })
        .scrollIntoViewIfNeeded();
      await panel.screenshot({
        path: path.join(output, "otter-mcp-remote.png"),
      });
      await panel.keyboard.press("Escape");
      await noteSay("用远程笔记记下 远程一条");
      await panel
        .getByRole("region", { name: "工具请求：记一条笔记" })
        .getByRole("button", { name: "允许一次", exact: true })
        .click();
      await panel
        .getByText("工具结果：记下了：远程一条", { exact: true })
        .waitFor();
      assert.equal(fs.readFileSync(remoteNotes, "utf8"), "远程一条\n");
      assert(remote.seen.some((m) => m.method === "tools/call"));
      await openTools();
      for (const name of ["chatnotes", "cloud"]) {
        await panel
          .getByRole("button", { name: `删除 ${name}`, exact: true })
          .click();
        await panel
          .getByRole("button", { name: "确认删除", exact: true })
          .click();
      }
      await panel.getByText("还没有接上 MCP 服务。").waitFor();
      await panel.keyboard.press("Escape");
    } finally {
      await remote.close();
      fs.rmSync(remoteNotes, { force: true });
    }
    // Skills: a folder with SKILL.md shows up after 重新扫描; the model reads
    // it through use_skill without a card; switched off, it is not offered.
    const skillDir = path.join(userData, "skills", "otter-haiku");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: otter-haiku\ndescription: 用户想要一首俳句时用\n---\n第一行写季节，第三行写水獭。\n",
    );
    await openTools();
    await panel.getByRole("button", { name: "重新扫描", exact: true }).click();
    const skillSwitch = panel.getByRole("checkbox", {
      name: "启用 skill otter-haiku",
      exact: true,
    });
    await skillSwitch.waitFor();
    await panel.keyboard.press("Escape");
    await chatSay("用 skill 写俳句");
    const offeredSkill = requests
      .filter((r) => r.body.stream && r.body.tools)
      .at(-2)
      .body.tools.find((t) => t.function.name === "use_skill");
    assert.deepEqual(offeredSkill.function.parameters.properties.name.enum, [
      "add-mcp-server",
      "claude-notes",
      "codex-helper",
      "otter-haiku",
      "shared-tips",
    ]);
    await panel.getByText("照着 skill：已读", { exact: true }).waitFor();
    await panel
      .locator(".chat-message.assistant")
      .last()
      .getByText("✓ 读 skill")
      .waitFor();
    await openTools();
    await skillSwitch.uncheck();
    await panel.keyboard.press("Escape");
    await chatSay("随便聊聊");
    const offeredNames = () =>
      requests.at(-1).body.tools.find((t) => t.function.name === "use_skill")
        .function.parameters.properties.name.enum;
    assert(
      !offeredNames().includes("otter-haiku"),
      "A switched-off skill is not offered",
    );
    // Other tools' folders: listed by source, a shared skill shown once with
    // where else it is, a switch per folder and per skill.
    await openTools();
    await panel
      .getByRole("checkbox", { name: "使用 Codex 的 skill" })
      .waitFor();
    const shared = panel.locator('.skill-source[aria-label="共享 的 skill"]');
    await shared.locator("summary").click();
    await shared.getByText("shared-tips 的用法（也在 Claude Code）").waitFor();
    assert.equal(
      await panel.getByText("hidden-system").count(),
      0,
      "Hidden system folders are skipped",
    );
    await panel.screenshot({
      path: path.join(output, "otter-skills-sources.png"),
    });
    await panel
      .getByRole("checkbox", { name: "使用 Codex 的 skill", exact: true })
      .uncheck();
    const claude = panel.locator(
      '.skill-source[aria-label="Claude Code 的 skill"]',
    );
    await claude.locator("summary").click();
    await claude
      .getByRole("checkbox", { name: "启用 skill claude-notes", exact: true })
      .uncheck();
    await panel.keyboard.press("Escape");
    await chatSay("随便聊聊，换个话题");
    assert.deepEqual(offeredNames(), ["add-mcp-server", "shared-tips"]);
    const skillPrefs = JSON.parse(
      fs.readFileSync(path.join(userData, "desktop.json"), "utf8"),
    ).skills;
    assert.deepEqual(skillPrefs.sourcesOff, ["codex"]);
    assert(skillPrefs.disabled.includes("claude-notes"));
    assert(
      fs.existsSync(
        path.join(skillsHome, ".codex/skills/codex-helper/SKILL.md"),
      ),
      "Other tools' skills are read in place, never moved",
    );
    // A skill installed in another tool while Otter runs is offered with the
    // next message, without opening settings.
    homeSkill(".agents/skills", "installed-later");
    await chatSay("刚装了一个 skill");
    assert(offeredNames().includes("installed-later"));
    // The shipped add-mcp-server skill: the model reads it, then proposes a
    // server through otter_add_mcp_server; the card says it in words, has no
    // "for this conversation", and nothing is added before 允许一次.
    await panel
      .getByRole("textbox", { name: "聊天输入" })
      .fill("用 skill 帮我添加笔记服务");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    const viaTool = panel.getByRole("region", {
      name: "工具请求：添加 MCP 服务",
    });
    await viaTool.getByText(/viatool：运行 .*fake-mcp-server\.cjs/).waitFor();
    await viaTool.getByText(/这份配置是水獭整理的/).waitFor();
    assert.equal(
      await viaTool.getByRole("button", { name: "这段对话都允许" }).count(),
      0,
    );
    await panel.screenshot({
      path: path.join(output, "otter-mcp-skill-card.png"),
    });
    await viaTool
      .getByRole("button", { name: "允许一次", exact: true })
      .click();
    await panel.getByText(/^添加结果：已添加：viatool/).waitFor();
    const usedSkill = requests.filter(
      (r) =>
        r.body.stream && lastUserOf(r.body).startsWith("用 skill 帮我添加"),
    );
    assert.match(
      usedSkill[1].body.messages.at(-1).content,
      /# Skill：add-mcp-server/,
      "The model read the skill before adding",
    );
    // A remote config in VS Code's shape (servers, type http) pasted into
    // settings: read as a network server, not as a missing command.
    const vscodeRemote = await startFakeHttpMcp({});
    try {
      await openTools();
      await panel
        .getByRole("article", { name: "MCP 服务：viatool" })
        .getByText("运行中 · 2 个工具", { exact: true })
        .waitFor();
      await panel
        .getByRole("region", { name: "MCP 服务" })
        .getByText("添加 MCP 服务", { exact: true })
        .click();
      await panel.getByRole("textbox", { name: "MCP 配置" }).fill(
        JSON.stringify({
          servers: { vscode: { type: "http", url: vscodeRemote.url } },
        }),
      );
      await panel
        .getByRole("button", { name: "检查配置", exact: true })
        .click();
      await panel.getByText(`vscode：${vscodeRemote.url}（HTTP）`).waitFor();
      await panel
        .getByRole("button", { name: "确认添加", exact: true })
        .click();
      await panel
        .getByRole("article", { name: "MCP 服务：vscode" })
        .getByText("运行中 · 2 个工具", { exact: true })
        .waitFor();
      for (const name of ["viatool", "vscode"]) {
        await panel
          .getByRole("button", { name: `删除 ${name}`, exact: true })
          .click();
        await panel
          .getByRole("button", { name: "确认删除", exact: true })
          .click();
      }
      await panel.getByText("还没有接上 MCP 服务。").waitFor();
      await panel.keyboard.press("Escape");
    } finally {
      await vscodeRemote.close();
    }
    // SSH 服务器: ~/.ssh/config hosts listed; a server added in settings logs
    // in; logins saved from chat (a key, and a password that only reaches the
    // keychain); a message with a password held back; a command run after
    // 允许一次.
    const openSsh = async () => {
      if (!(await panel.getByRole("dialog", { name: "设置" }).isVisible()))
        await panel.getByRole("button", { name: "设置", exact: true }).click();
      await panel
        .getByRole("navigation", { name: "设置分组" })
        .getByRole("button", { name: "SSH 服务器" })
        .click();
    };
    await openSsh();
    await panel
      .getByRole("article", { name: "服务器：lab" })
      .getByText("ops@lab.example.com · 来自 ~/.ssh/config")
      .waitFor();
    await panel
      .getByRole("button", { name: "添加服务器", exact: true })
      .click();
    const form = panel.getByRole("form", { name: "添加服务器" });
    await form.getByRole("textbox", { name: "名称" }).fill("local");
    await form.getByRole("textbox", { name: "主机" }).fill("127.0.0.1");
    await form.getByRole("textbox", { name: "端口" }).fill(String(sshd.port));
    await form.getByRole("textbox", { name: "用户名" }).fill(sshd.user);
    await form.getByRole("textbox", { name: "密钥文件" }).fill(sshd.key);
    await form.getByRole("button", { name: "保存服务器", exact: true }).click();
    const local = panel.getByRole("article", { name: "服务器：local" });
    await local.waitFor();
    await local.getByRole("button", { name: "测试连接 local" }).click();
    await local.getByText("能登录 local。", { exact: true }).waitFor();
    await local.getByRole("button", { name: "打开终端 local" }).click();
    await local.getByText("已在终端打开 local。", { exact: true }).waitFor();
    await panel.screenshot({
      path: path.join(output, "otter-ssh-settings.png"),
    });
    await panel.keyboard.press("Escape");
    const sshCard = panel.getByRole("region", { name: "办事确认" });
    await noteSay(
      `保存服务器 box：${sshd.user}@127.0.0.1 端口 ${sshd.port}，密钥 ${sshd.key}`,
    );
    await sshCard
      .getByText(`地址：${sshd.user}@127.0.0.1:${sshd.port}`)
      .waitFor();
    await sshCard
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await panel.getByText(/^已保存服务器 box/).waitFor();
    await noteSay("保存服务器 pwbox：me@10.9.8.7 密码：S3cret!pass");
    await sshCard.getByText(/登录方式：密码（存进钥匙串）/).waitFor();
    await sshCard.getByText(/没有发给模型/).waitFor();
    assert.match(taskRequests.at(-1).text, /密码：••••/);
    await panel.screenshot({
      path: path.join(output, "otter-ssh-save-card.png"),
    });
    await sshCard
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await panel.getByText(/^已保存服务器 pwbox/).waitFor();
    const pwbox = JSON.parse(
      fs.readFileSync(path.join(userData, "desktop.json"), "utf8"),
    ).ssh.hosts.find((h) => h.name === "pwbox");
    assert.equal(pwbox.auth, "password");
    assert(!JSON.stringify(pwbox).includes("S3cret"));
    const stored = execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "Otter SSH",
      "-a",
      pwbox.id,
      "-w",
      sshKeychain,
    ]).toString();
    assert.equal(
      Buffer.from(stored.trim(), "base64").toString(),
      "S3cret!pass",
    );
    await noteSay("我的密码是：Hunter2pass 帮我记一下");
    await panel.getByText(/这条消息里有密码，Otter 没有把它发给模型/).waitFor();
    const everything = JSON.stringify([requests, taskRequests, memoryRequests]);
    assert(!everything.includes("S3cret!pass"), "No password reached a model");
    assert(!everything.includes("Hunter2pass"), "No password reached a model");
    const history = await panel.evaluate(async () => {
      const [latest] = await window.otter.call("chat.sessions", {});
      return JSON.stringify(
        await window.otter.call("chat.history", { session_id: latest.id }),
      );
    });
    assert(
      !history.includes("S3cret!pass") && !history.includes("Hunter2pass"),
    );
    await noteSay("在 box 上看看我是谁");
    const runCard = panel.getByRole("region", {
      name: "工具请求：在服务器上运行命令",
    });
    await runCard.getByText(/echo smoke-\$\(whoami\)/).waitFor();
    assert.equal(
      await runCard.getByRole("button", { name: "这段对话都允许" }).count(),
      0,
    );
    await panel.screenshot({
      path: path.join(output, "otter-ssh-run-card.png"),
    });
    await runCard
      .getByRole("button", { name: "允许一次", exact: true })
      .click();
    await panel
      .getByText(new RegExp(`命令结果：退出码 0[\\s\\S]*smoke-${sshd.user}`))
      .waitFor();
    await openSsh();
    for (const name of ["local", "box", "pwbox"]) {
      await panel
        .getByRole("button", { name: `删除 ${name}`, exact: true })
        .click();
      await panel
        .getByRole("button", { name: "确认删除", exact: true })
        .click();
      await panel
        .getByRole("article", { name: `服务器：${name}` })
        .waitFor({ state: "detached" });
    }
    assert.throws(
      () =>
        execFileSync(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-s",
            "Otter SSH",
            "-a",
            pwbox.id,
            sshKeychain,
          ],
          { stdio: "ignore" },
        ),
      "Deleting the server deletes its password",
    );
    await panel.keyboard.press("Escape");
    console.log(
      "PASS: SSH servers: ~/.ssh/config hosts listed; one added in settings tests and opens; logins saved from chat after a card, a typed password kept from the model and the chat and stored only in the keychain; a message with a password held back; a command run on a real sshd after 允许一次; deleting removes the password.",
    );
    console.log(
      "PASS: reading a web page asks first and refuses this Mac and the local network; MCP server added from settings: preview first, its tools offered, a writing call waits for the card, 允许一次 runs it, 拒绝 does not, 不用再问 skips the card, disable and remove; servers added from chat after a card (a pasted command, and a remote HTTP server with a token whose tool then runs after 允许); a skill found by 重新扫描, read through use_skill, and not offered once off; Codex, Claude Code and shared skill folders read in place, merged when linked, switched per folder and per skill, and one installed later offered with the next message; the shipped add-mcp-server skill read, then a server proposed through otter_add_mcp_server and added after 允许一次; a VS Code-shaped remote config pasted into settings.",
    );
    await panel.getByRole("button", { name: "新对话", exact: true }).click();
    await panel
      .getByRole("heading", { name: "我在这里，慢慢说。", exact: true })
      .waitFor();
    const beforeMemory = requests.length;
    await chatSay("记住：我正在做桌面机器人，下一步接舵机");
    await panel
      .getByText("已存入记忆：我正在做桌面机器人", { exact: false })
      .waitFor();
    assert.equal(requests.length, beforeMemory);
    await chatSay("我们继续");
    assert(requests.at(-1).body.messages[0].content.includes("下一步接舵机"));
    await panel.getByText("本次参考的记忆 · 1", { exact: true }).click();
    await panel
      .getByRole("button", { name: "不对？去修改", exact: true })
      .click();
    await panel
      .getByRole("heading", { name: "修改这条记忆", exact: true })
      .waitFor();
    await panel
      .getByRole("textbox", { name: "记忆内容", exact: true })
      .fill("我正在做桌面机器人，舵机已接好，下一步接屏幕");
    await panel.getByRole("button", { name: "保存修改", exact: true }).click();
    await panel.getByText("修改已保存。", { exact: true }).waitFor();
    await panel
      .getByRole("textbox", { name: "你的称呼", exact: true })
      .fill("小杨");
    await panel
      .getByRole("button", { name: "保存相处方式", exact: true })
      .click();
    await panel.getByText("相处方式已保存。", { exact: true }).waitFor();
    await panel.screenshot({ path: path.join(output, "otter-memory.png") });
    await go(panel, "与水獭聊天");
    await panel
      .getByText("已存入记忆：我正在做桌面机器人", { exact: false })
      .waitFor();
    await chatSay("我们继续");
    const recalled = requests.at(-1).body.messages[0].content;
    assert(recalled.includes("下一步接屏幕") && recalled.includes("小杨"));
    assert(!recalled.includes("下一步接舵机"));
    await chatSay("这件事不要记住");
    await chatSay("忘掉刚才那条");
    await panel
      .getByText("已从记忆删除：我正在做桌面机器人", { exact: false })
      .waitFor();
    assert.equal(requests.length, beforeMemory + 2);
    await go(panel, "记忆与个性");
    await panel.getByText("还没有记忆。", { exact: false }).waitFor();
    await panel
      .getByRole("button", { name: "告诉它一件事", exact: false })
      .click();
    await panel
      .getByRole("textbox", { name: "记忆标题", exact: true })
      .fill("回答风格");
    await panel
      .getByRole("textbox", { name: "记忆内容", exact: true })
      .fill("喜欢简洁的回答");
    await panel.getByRole("button", { name: "保存记忆", exact: true }).click();
    await panel.getByRole("article", { name: "记忆：回答风格" }).waitFor();
    await panel
      .getByRole("button", { name: "清空全部记忆", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "确认删除记忆", exact: true })
      .click();
    await panel
      .getByText("长期记忆和个性设置已清空。", { exact: true })
      .waitFor();
    assert.equal(
      await panel
        .getByRole("textbox", { name: "你的称呼", exact: true })
        .inputValue(),
      "",
    );
    await panel
      .getByRole("checkbox", { name: "从聊天建议记忆", exact: true })
      .check();
    await panel
      .getByRole("checkbox", { name: "按意思检索记忆", exact: true })
      .check();
    await panel
      .getByRole("button", { name: "保存增强设置", exact: true })
      .click();
    await panel.getByText("增强记忆设置已保存。", { exact: true }).waitFor();
    await go(panel, "与水獭聊天");
    await panel.getByRole("button", { name: "新对话", exact: true }).click();
    await panel
      .getByRole("heading", { name: "我在这里，慢慢说。", exact: true })
      .waitFor();
    await chatSay("我家猫叫糯米，它三岁了。");
    const catCandidate = panel.getByRole("article", {
      name: "待确认记忆：糯米",
      exact: true,
    });
    await catCandidate.waitFor();
    assert.equal(
      (await panel.evaluate(() => window.otter.call("memory.get"))).entries
        .length,
      0,
    );
    await catCandidate
      .getByRole("button", { name: "修改后确认", exact: true })
      .click();
    await catCandidate
      .getByRole("textbox", { name: "建议内容", exact: true })
      .fill("我家猫叫糯米，今年四岁。");
    await catCandidate
      .getByRole("button", { name: "确认记住", exact: true })
      .click();
    await panel
      .getByText("已确认并保存为长期记忆。", { exact: true })
      .waitFor();
    await chatSay("毛孩子叫什么名字？");
    assert(requests.at(-1).body.messages[0].content.includes("糯米"));
    assert(requests.at(-1).body.messages[0].content.includes("今年四岁"));
    assert(
      memoryRequests.some(
        (r) =>
          r.purpose.startsWith("[Otter semantic") &&
          r.payload.query === "毛孩子叫什么名字？",
      ),
    );
    const lookups = memoryRequests.filter((r) =>
      r.purpose.startsWith("[Otter semantic"),
    ).length;
    await panel
      .getByRole("checkbox", { name: "本轮使用记忆", exact: true })
      .uncheck();
    await chatSay("毛孩子叫什么名字？");
    assert.equal(
      memoryRequests.filter((r) => r.purpose.startsWith("[Otter semantic"))
        .length,
      lookups,
    );
    assert(!requests.at(-1).body.messages[0].content.includes("今年四岁"));
    await chatSay("本次语义故障测试");
    await panel
      .getByText("语义检索这次暂不可用，已使用关键词检索继续聊天。", {
        exact: true,
      })
      .waitFor();
    await chatSay("我喜欢提前规划旅行");
    const travelCandidate = panel.getByRole("article", {
      name: "待确认记忆：旅行偏好",
      exact: true,
    });
    await travelCandidate.waitFor();
    await travelCandidate.scrollIntoViewIfNeeded();
    await panel.screenshot({
      path: path.join(output, "otter-smart-memory.png"),
    });
    await travelCandidate
      .getByRole("button", { name: "不记住", exact: true })
      .click();
    await panel
      .getByText("这条建议已忽略，没有写入长期记忆。", { exact: true })
      .waitFor();
    assert.equal(
      (await panel.evaluate(() => window.otter.call("memory.get"))).entries
        .length,
      1,
    );
    await chatSay("忘掉刚才那条");
    assert.equal(
      (await panel.evaluate(() => window.otter.call("memory.get"))).entries
        .length,
      0,
    );
    await panel.evaluate(() =>
      window.otter.call("memory.ai-configure", {
        suggestions: false,
        semantic: false,
      }),
    );
    const petMemoryDenied = await pet.evaluate(async () => {
      try {
        await window.otter.call("memory.get");
        return false;
      } catch {
        return true;
      }
    });
    assert(petMemoryDenied);
    await verifyProjects({
      panel,
      pet,
      apiUrl,
      requests,
      projectRequests,
      output,
    });
    await verifyHandoff({ panel, pet, userData, output });
    await go(panel, "与水獭聊天");
    await panel.getByRole("button", { name: "新对话", exact: true }).click();
    await panel
      .getByRole("heading", { name: "我在这里，慢慢说。", exact: true })
      .waitFor();
    const taskInput = panel.getByRole("textbox", {
      name: "聊天输入",
      exact: true,
    });
    const themeOf = (page) =>
      page.evaluate(() => document.documentElement.dataset.theme);
    const taskSend = async (text) => {
      await taskInput.fill(text);
      await panel.getByRole("button", { name: "发送", exact: true }).click();
    };
    const taskState = () =>
      panel.evaluate(() => window.otter.action("assistant.get"));
    await taskSend("明天上午十点提醒我检查机器人");
    await panel.getByRole("region", { name: "办事确认" }).waitFor();
    assert(
      !(await taskState()).reminders.some((r) => r.title === "检查机器人"),
    );
    await panel.screenshot({
      path: path.join(output, "otter-task-confirmation.png"),
    });
    await panel
      .getByRole("button", { name: "确认创建提醒", exact: true })
      .click();
    await panel.getByText(/已创建提醒：检查机器人/).waitFor();
    const initialReminder = (await taskState()).reminders.find(
      (r) => r.title === "检查机器人",
    );
    assert(initialReminder);
    await taskSend("把刚才那个提醒推迟半小时");
    await panel.getByRole("button", { name: "确认执行", exact: true }).click();
    await panel.getByText(/已修改提醒：检查机器人/).waitFor();
    assert.equal(
      (await taskState()).reminders.find((r) => r.id === initialReminder.id)
        .dueAt,
      initialReminder.dueAt + 1800000,
    );
    await taskSend("看看我有哪些提醒");
    await panel.getByText(/本机提醒：共/).waitFor();
    await taskSend("取消刚才那个提醒");
    await panel.getByRole("button", { name: "确认执行", exact: true }).click();
    await panel.getByText("已取消提醒：检查机器人", { exact: true }).waitFor();
    assert.equal(
      (await taskState()).reminders.find((r) => r.id === initialReminder.id)
        .status,
      "cancelled",
    );
    await taskSend("记个待办：测试机器人动作");
    await panel.getByRole("button", { name: "确认执行", exact: true }).click();
    await panel
      .getByText("已添加待办：测试机器人动作", { exact: true })
      .waitFor();
    await taskSend("刚才的待办完成了");
    await panel.getByRole("button", { name: "确认执行", exact: true }).click();
    await panel
      .getByText("已完成待办：测试机器人动作", { exact: true })
      .waitFor();
    assert(
      (await taskState()).todos.find((t) => t.title === "测试机器人动作").done,
    );
    await taskSend("查看已完成待办");
    await panel.getByText(/本机待办：共/).waitFor();
    await taskSend("帮我提醒一下");
    await panel
      .getByText("请告诉我提醒的具体时间和内容。", { exact: true })
      .waitFor();
    await taskSend("打开计算器");
    await panel.getByRole("button", { name: "取消操作", exact: true }).click();
    assert.equal(
      await panel.getByRole("region", { name: "办事确认" }).count(),
      0,
    );
    // Settings from chat: the planner sees what may change and nothing else;
    // a change waits for the card, takes effect app-wide and can be undone.
    await taskSend("换成夜里小窝主题");
    const settingCard = panel.getByRole("region", { name: "办事确认" });
    await settingCard.getByText("主题：暖阳小窝 → 夜里小窝").waitFor();
    const offered = taskRequests.at(-1).tasks.settings;
    assert.equal(offered.find((r) => r.id === "theme").current, "warm");
    assert(offered.some((r) => r.id === "memory.tone"));
    assert(
      !offered.some((r) => /^(models|handoff|workspace)/.test(r.id)),
      "Model, handoff and workspace are never offered",
    );
    assert.equal(await themeOf(panel), "warm", "Nothing changes before 确认");
    await settingCard
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await panel.getByText("已把主题改为夜里小窝。", { exact: true }).waitFor();
    await panel.waitForFunction(
      () => document.documentElement.dataset.theme === "night",
    );
    await pet.waitForFunction(
      () => document.documentElement.dataset.theme === "night",
    );
    await panel.screenshot({
      path: path.join(output, "otter-setting-from-chat.png"),
    });
    await panel.getByRole("button", { name: "撤销", exact: true }).click();
    await panel
      .getByText("已撤销：主题改回暖阳小窝。", { exact: true })
      .waitFor();
    await panel.waitForFunction(
      () => document.documentElement.dataset.theme === "warm",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(userData, "desktop.json"), "utf8"))
        .theme,
      "warm",
    );
    await taskSend("安静模式现在开着吗");
    await panel.getByText(/^安静模式：(开|关)。$/).waitFor();
    await taskSend("把模型密钥改成 abc");
    await panel.getByText(/模型和密钥请到设置里手动改/).waitFor();
    assert.equal(
      await panel.getByRole("region", { name: "办事确认" }).count(),
      0,
      "No card for a setting chat may not change",
    );
    // 背景图片: picked in settings, served only through otter-backdrop:,
    // faded by the slider, switched back from 用过的, changed from chat after
    // a card and undone; a path the user never named is not offered.
    const backdropState = () =>
      JSON.parse(fs.readFileSync(path.join(userData, "desktop.json"), "utf8"))
        .backdrop;
    const layer = () =>
      panel.evaluate(() => {
        const style = getComputedStyle(
          document.querySelector(".app-shell"),
          "::before",
        );
        return {
          on: document.documentElement.dataset.backdrop === "on",
          image: style.backgroundImage,
          opacity: Number(style.opacity),
        };
      });
    const loads = (url) =>
      panel.evaluate(
        (url) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth);
            img.onerror = () => resolve(0);
            img.src = url;
          }),
        url,
      );
    await go(panel, "偏好设置");
    const backdropSection = panel.getByRole("region", { name: "背景图片" });
    assert.equal((await layer()).on, false);
    await backdropSection
      .getByRole("button", { name: "选一张图片…", exact: true })
      .click();
    await panel.waitForFunction(
      () => document.documentElement.dataset.backdrop === "on",
    );
    await backdropSection.getByText("橘子海.png", { exact: true }).waitFor();
    const picked = backdropState();
    assert.equal(picked.transparency, 40);
    assert.match(picked.current, /^[0-9a-f]{16}\.png$/);
    assert.deepEqual(
      fs.readFileSync(path.join(userData, "backgrounds", picked.current)),
      fs.readFileSync(backdropPick),
      "A PNG within size is kept byte for byte",
    );
    const pickedUrl = `otter-backdrop://image/${picked.current}`;
    assert.equal(await loads(pickedUrl), 1200, "The page can draw the copy");
    assert.equal(
      await loads("otter-backdrop://image/0123456789abcdef.png"),
      0,
      "Files that are not listed are not served",
    );
    await panel.waitForFunction(
      () =>
        Number(
          getComputedStyle(document.querySelector(".app-shell"), "::before")
            .opacity,
        ) === 0.6,
    );
    assert((await layer()).image.includes(pickedUrl));
    // Four steps right on the slider: 40% → 60%, so 0.4 of the picture shows.
    const slider = backdropSection.getByRole("slider", {
      name: "背景图透明度",
    });
    await slider.focus();
    for (let i = 0; i < 4; i++) await panel.keyboard.press("ArrowRight");
    await backdropSection.getByText("60%", { exact: true }).waitFor();
    await panel.waitForFunction(
      () =>
        Number(
          getComputedStyle(document.querySelector(".app-shell"), "::before")
            .opacity,
        ) === 0.4,
    );
    for (let i = 0; i < 50 && backdropState().transparency !== 60; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(backdropState().transparency, 60, "The slider is saved");
    await panel.screenshot({
      path: path.join(output, "otter-backdrop-settings.png"),
    });
    assert(
      await pet.evaluate(async () => {
        try {
          await window.otter.action("backdrop.clear");
          return false;
        } catch {
          return true;
        }
      }),
      "The pet window cannot change the background",
    );
    await panel.keyboard.press("Escape");
    // From chat: a large HEIC is converted and scaled after 确认.
    await taskSend(`背景换成 ${backdropHeic}`);
    const heicName = path.basename(backdropHeic);
    await settingCard
      .getByText(`背景图：橘子海.png → ${heicName}`, { exact: true })
      .waitFor();
    const offeredBackdrop = taskRequests
      .at(-1)
      .tasks.settings.filter((r) => r.id.startsWith("backdrop."));
    assert.deepEqual(
      offeredBackdrop.map((r) => [r.id, r.type, r.current]),
      [
        [
          "backdrop.image",
          "text",
          path.join(userData, "backgrounds", picked.current),
        ],
        ["backdrop.transparency", "number", 60],
      ],
    );
    assert(offeredBackdrop[0].path && offeredBackdrop[0].empty);
    assert.equal(backdropState().current, picked.current, "Not before 确认");
    await settingCard
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await panel
      .getByText(`已把背景图改为${heicName}。`, { exact: true })
      .waitFor();
    const converted = backdropState().current;
    assert.match(converted, /^[0-9a-f]{16}\.jpg$/);
    const size = execFileSync("/usr/bin/sips", [
      "-g",
      "pixelWidth",
      path.join(userData, "backgrounds", converted),
    ]).toString();
    assert(
      Number(/pixelWidth: (\d+)/.exec(size)[1]) <= 3200,
      "Large pictures are scaled down",
    );
    await panel.waitForFunction(
      (file) =>
        getComputedStyle(
          document.querySelector(".app-shell"),
          "::before",
        ).backgroundImage.includes(file),
      converted,
    );
    await panel.screenshot({
      path: path.join(output, "otter-backdrop-chat.png"),
    });
    await panel.getByRole("button", { name: "撤销", exact: true }).click();
    await panel
      .getByText("已撤销：背景图改回橘子海.png。", { exact: true })
      .waitFor();
    assert.equal(backdropState().current, picked.current);
    await taskSend("背景图透明度调到 80");
    await settingCard
      .getByText("背景图透明度：60% → 80%", { exact: true })
      .waitFor();
    await settingCard
      .getByRole("button", { name: "确认执行", exact: true })
      .click();
    await panel
      .getByText("已把背景图透明度改为80%。", { exact: true })
      .waitFor();
    await panel.waitForFunction(
      () =>
        Number(
          getComputedStyle(document.querySelector(".app-shell"), "::before")
            .opacity,
        ) === 0.2,
    );
    const refusals = panel.getByText(/模型和密钥请到设置里手动改/);
    const refused = await refusals.count();
    await taskSend("背景换成海边那张");
    await refusals.nth(refused).waitFor();
    assert.equal(
      await settingCard.count(),
      0,
      "No card for a picture the user never named",
    );
    // Back in settings: 用过的 switches back, 不用背景图 turns it off but
    // keeps the copies, and × deletes one.
    await go(panel, "偏好设置");
    await backdropSection
      .getByRole("button", { name: `用 ${heicName} 做背景`, exact: true })
      .click();
    await panel.waitForFunction(
      (file) =>
        getComputedStyle(
          document.querySelector(".app-shell"),
          "::before",
        ).backgroundImage.includes(file),
      converted,
    );
    await backdropSection
      .getByRole("button", { name: "不用背景图", exact: true })
      .click();
    await panel.waitForFunction(
      () => document.documentElement.dataset.backdrop !== "on",
    );
    assert.equal(backdropState().current, null);
    assert.equal(backdropState().recent.length, 2);
    await backdropSection
      .getByRole("button", { name: "删除 橘子海.png", exact: true })
      .click();
    await backdropSection
      .getByRole("button", { name: "删除 橘子海.png", exact: true })
      .waitFor({ state: "detached" });
    assert.deepEqual(fs.readdirSync(path.join(userData, "backgrounds")), [
      converted,
    ]);
    await backdropSection
      .getByRole("button", { name: `用 ${heicName} 做背景`, exact: true })
      .click();
    await panel.waitForFunction(
      () => document.documentElement.dataset.backdrop === "on",
    );
    await panel.reload();
    await panel.waitForFunction(
      (file) =>
        document.documentElement.dataset.backdrop === "on" &&
        getComputedStyle(
          document.querySelector(".app-shell"),
          "::before",
        ).backgroundImage.includes(file),
      converted,
    );
    await go(panel, "偏好设置");
    await panel
      .getByRole("region", { name: "背景图片" })
      .getByRole("button", { name: "不用背景图", exact: true })
      .click();
    await panel.waitForFunction(
      () => document.documentElement.dataset.backdrop !== "on",
    );
    await panel.keyboard.press("Escape");
    await go(panel, "与水獭聊天");
    console.log(
      "PASS: background picture picked in settings and kept byte for byte, drawn only through otter-backdrop:, faded by the transparency slider and saved; a large HEIC set from chat after a card, converted and scaled, then undone; transparency changed from chat; a path never named refused; switched back from 用过的, turned off, one deleted, and kept after a reload; the pet cannot change it.",
    );
    if (process.env.OTTER_TEST_TASK_ACTIONS === "1") {
      const calculatorAlreadyRunning = (await nativeRead("apps")).apps.some(
        (a) => a.bundleId === "com.apple.calculator",
      );
      console.log(
        "Calculator running before task test:",
        calculatorAlreadyRunning,
      );
      await taskSend("打开计算器");
      await panel
        .getByRole("button", { name: "确认执行", exact: true })
        .click();
      await panel.getByText(/已请求 macOS 打开应用/).waitFor();
      assert(
        (await nativeRead("apps")).apps.some(
          (a) => a.bundleId === "com.apple.calculator",
        ),
      );
      const countBeforeTaskLink = openedLink;
      await taskSend("打开这个网页 " + apiUrl.replace("/v1", "/action-target"));
      await panel
        .getByRole("button", { name: "确认执行", exact: true })
        .click();
      await panel.getByText(/已交给默认浏览器打开链接/).waitFor();
      for (let i = 0; i < 50 && openedLink === countBeforeTaskLink; i++)
        await new Promise((r) => setTimeout(r, 100));
      assert(
        openedLink > countBeforeTaskLink,
        "Task confirmation must reach the browser",
      );
      console.log(
        "PASS: conversational app launch and loopback browser navigation",
      );
    }
    await taskSend("办事格式故障测试");
    await panel
      .getByRole("button", { name: "重新理解", exact: true })
      .waitFor();
    assert.equal(await taskInput.inputValue(), "办事格式故障测试");
    await panel
      .getByRole("button", { name: "仅聊天发送", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "停止回复", exact: true })
      .waitFor({ state: "detached" });
    await taskSend("取消分析测试");
    await panel.getByRole("button", { name: "停止理解", exact: true }).click();
    await panel.waitForTimeout(900);
    assert.equal(
      await panel.getByRole("region", { name: "办事确认" }).count(),
      0,
    );
    assert(!(await taskState()).todos.some((t) => t.title === "不应出现"));
    const analyses = taskRequests.length;
    await panel
      .getByRole("checkbox", { name: "理解办事请求", exact: true })
      .uncheck();
    await taskSend("这是一句普通闲聊");
    await panel
      .getByRole("button", { name: "停止回复", exact: true })
      .waitFor({ state: "detached" });
    assert.equal(taskRequests.length, analyses);
    await go(panel, "生活助手");
    await go(panel, "与水獭聊天");
    await panel.waitForFunction(
      async () => !(await window.otter.action("tasks.settings")).enabled,
    );
    await panel.waitForFunction(() => {
      const input = document.querySelectorAll("input[type=checkbox]");
      return [...input].some(
        (i) =>
          i.parentElement.textContent.includes("理解办事请求") &&
          !i.disabled &&
          !i.checked,
      );
    });
    assert.equal(
      await panel
        .getByRole("checkbox", { name: "理解办事请求", exact: true })
        .isChecked(),
      false,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(userData, "desktop.json"), "utf8"))
        .tasks.enabled,
      false,
    );
    assert(
      await pet.evaluate(async () => {
        try {
          await window.otter.action("tasks.plan", {
            text: "测试",
            sessionId: "x",
            requestId: "x",
          });
          return false;
        } catch {
          return true;
        }
      }),
    );
    assert(
      await panel.evaluate(async () => {
        try {
          await window.otter.call("tasks.record", {});
          return false;
        } catch {
          return true;
        }
      }),
    );
    console.log(
      "PASS: conversational reminders, edits, queries, cancellation, todos, app preview, settings changed and undone from chat, malformed model output, stopped analysis and IPC guards.",
    );
    await panel
      .getByRole("checkbox", { name: "理解办事请求", exact: true })
      .check();
    await go(panel, "偏好设置");
    await panel
      .getByRole("button", { name: "恢复原模型", exact: true })
      .click();
    await panel.getByText("离线演示模式", { exact: true }).waitFor();
    await go(panel, "生活助手");
    await panel
      .getByRole("button", { name: "开始 25 分钟专注", exact: true })
      .click();
    await panel
      .getByRole("heading", { name: "正在专注", exact: true })
      .waitFor();
    assert(
      (await panel.evaluate(() => window.otter.action("assistant.get"))).focus,
    );
    await panel.getByRole("button", { name: "结束专注", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "新待办", exact: true })
      .fill("测试待办");
    await panel.getByRole("button", { name: "添加待办", exact: true }).click();
    await panel.getByText("测试待办", { exact: true }).waitFor();
    await openScenes(panel);
    await panel
      .getByRole("textbox", { name: "现场名称", exact: true })
      .fill("测试工作现场");
    await panel
      .getByRole("textbox", { name: "页面与工作背景", exact: true })
      .fill("https://example.com/test");
    await panel
      .getByRole("textbox", { name: "当前问题", exact: true })
      .fill("怎样继续？");
    await panel
      .getByRole("textbox", { name: "下一步", exact: true })
      .fill("先验证保存与恢复");
    await panel
      .getByRole("button", { name: "保存工作现场", exact: true })
      .click();
    const countBeforeRestore = requests.length;
    await panel
      .getByRole("button", { name: "在聊天中继续", exact: true })
      .click();
    await panel
      .getByRole("textbox", { name: "附带上下文", exact: true })
      .waitFor();
    assert(
      (
        await panel
          .getByRole("textbox", { name: "附带上下文", exact: true })
          .inputValue()
      ).includes("先验证保存与恢复"),
    );
    assert.equal(requests.length, countBeforeRestore);
    await panel.getByRole("button", { name: "移除附件", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "聊天输入", exact: true })
      .fill("3秒后提醒我测试计时");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await panel
      .getByRole("button", { name: "确认创建提醒", exact: true })
      .waitFor();
    assert.equal(requests.length, countBeforeRestore);
    await panel
      .getByRole("button", { name: "确认创建提醒", exact: true })
      .click();
    await panel.waitForFunction(async () =>
      (await window.otter.action("assistant.get")).reminders.some(
        (r) => r.title === "测试计时" && r.status === "due",
      ),
    );
    await go(panel, "生活助手");
    await panel.getByRole("button", { name: "知道了", exact: true }).click();
    await panel
      .getByText("测试计时", { exact: true })
      .waitFor({ state: "detached" });
    await panel.locator("main").evaluate((element) => (element.scrollTop = 0));
    await panel.screenshot({ path: path.join(output, "otter-assistant.png") });
    await openScenes(panel);
    await panel.getByRole("button", { name: "删除现场", exact: true }).click();
    await panel
      .getByRole("button", { name: "确认删除现场", exact: true })
      .click();
    assert.equal(
      (await panel.evaluate(() => window.otter.action("assistant.get")))
        .sessions.length,
      0,
    );
    if (process.env.OTTER_TEST_OS_ACTIONS === "1") {
      await openTools(panel);
      await panel
        .getByRole("combobox", { name: "操作类型", exact: true })
        .selectOption("open_url");
      await panel
        .getByRole("textbox", { name: "操作目标", exact: true })
        .fill(apiUrl.replace("/v1", "/action-target"));
      await panel
        .getByRole("button", { name: "预览操作", exact: true })
        .click();
      await panel
        .getByRole("button", { name: "取消操作", exact: true })
        .click();
      assert.equal(openedLink, 0);
      await panel
        .getByRole("button", { name: "预览操作", exact: true })
        .click();
      await panel
        .getByRole("button", { name: "确认执行", exact: true })
        .click();
      for (let i = 0; i < 100 && openedLink === 0; i++)
        await new Promise((r) => setTimeout(r, 100));
      assert(
        openedLink > 0,
        "Default browser should open the confirmed local URL",
      );
      const beforeApps = await nativeRead("apps");
      const hadCalculator = beforeApps.apps.some(
        (a) => a.bundleId === "com.apple.calculator",
      );
      await panel
        .getByRole("combobox", { name: "操作类型", exact: true })
        .selectOption("open_app");
      await panel
        .getByRole("textbox", { name: "操作目标", exact: true })
        .fill("com.apple.calculator");
      await panel
        .getByRole("button", { name: "预览操作", exact: true })
        .click();
      await panel
        .getByRole("button", { name: "确认执行", exact: true })
        .click();
      let hasCalculator = false;
      for (let i = 0; i < 20; i++) {
        hasCalculator = (await nativeRead("apps")).apps.some(
          (a) => a.bundleId === "com.apple.calculator",
        );
        if (hasCalculator) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert(hasCalculator);
      if (!hadCalculator)
        execFileSync("/usr/bin/osascript", [
          "-l",
          "JavaScript",
          "-e",
          'ObjC.import("AppKit");var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.calculator");for(var i=0;i<a.count;i++)a.objectAtIndex(i).terminate;',
        ]);
    }
    await go(panel, "偏好设置");
    await panel
      .getByRole("checkbox", { name: "安静模式", exact: true })
      .uncheck();
    await panel
      .getByRole("checkbox", { name: "开启主动陪伴", exact: true })
      .check();
    await panel
      .getByRole("button", { name: "保存陪伴设置", exact: true })
      .click();
    await panel.getByText("陪伴设置已保存。", { exact: true }).waitFor();
    await go(panel, "工作简报");
    await panel.getByRole("button", { name: "生成简报", exact: true }).click();
    await panel.waitForFunction(
      async () => (await window.otter.action("ambient.get")).state.count === 1,
    );
    await go(panel, "偏好设置");
    await panel
      .getByRole("checkbox", { name: "开启主动陪伴", exact: true })
      .uncheck();
    await panel
      .getByRole("button", { name: "保存陪伴设置", exact: true })
      .click();
    if (process.env.OTTER_TEST_SPEECH === "1") {
      await go(panel, "与水獭聊天");
      await panel.evaluate(() =>
        window.otter.action(
          "voice.speak",
          "这是 Otter 的系统朗读测试。".repeat(30),
        ),
      );
      await panel.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "停止朗读" && !b.disabled,
        ),
      );
      await panel
        .getByRole("button", { name: "停止朗读", exact: true })
        .click();
      assert.equal(
        (await panel.evaluate(() => window.otter.action("voice.state")))
          .speaking,
        false,
      );
    }
    // 今天's ask bar hands its text to chat, which sends it once it is ready.
    await go(panel, "生活助手");
    await panel
      .getByRole("textbox", { name: "跟水獭说", exact: true })
      .fill("从今天页发来的一句话");
    await panel.getByRole("button", { name: "发给水獭", exact: true }).click();
    await panel
      .locator(".chat-message.user")
      .filter({ hasText: "从今天页发来的一句话" })
      .waitFor();
    assert.equal(
      await panel
        .getByRole("textbox", { name: "聊天输入", exact: true })
        .inputValue(),
      "",
      "The handed-over text is sent, not left in the box",
    );
    console.log("PASS: 今天's ask bar opens chat and sends the text.");
    // Themes: the panel picks one, both windows re-colour, macOS follows, and
    // the choice survives a reload; the pet window cannot change it.
    const appearance = () =>
      app.evaluate(({ nativeTheme, BrowserWindow }) => ({
        source: nativeTheme.themeSource,
        dark: nativeTheme.shouldUseDarkColors,
        colors: BrowserWindow.getAllWindows().map((w) =>
          w.getBackgroundColor().toLowerCase(),
        ),
      }));
    await go(panel, "偏好设置");
    await panel.getByRole("radio", { name: "夜里小窝", exact: true }).click();
    await panel.waitForFunction(
      () => document.documentElement.dataset.theme === "night",
    );
    await pet.waitForFunction(
      () => document.documentElement.dataset.theme === "night",
    );
    const look = await appearance();
    assert.equal(look.source, "dark");
    assert(look.colors.includes("#1d1713"), look.colors.join());
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(userData, "desktop.json"), "utf8"))
        .theme,
      "night",
    );
    await panel.screenshot({
      path: path.join(output, "otter-theme-night.png"),
    });
    for (const [page, value] of [
      [pet, "mint"],
      [panel, "neon"],
    ])
      assert(
        await page.evaluate(async (value) => {
          try {
            await window.otter.action("theme", value);
            return false;
          } catch {
            return true;
          }
        }, value),
        "Only the panel sets a known theme",
      );
    await panel.reload();
    await panel.waitForFunction(
      async () =>
        (await window.otter.action("snapshot")).preferences.theme === "night",
    );
    assert.equal(await themeOf(panel), "night");
    await go(panel, "偏好设置");
    await panel.getByRole("radio", { name: "跟随系统", exact: true }).click();
    await panel.waitForFunction(
      async () =>
        (await window.otter.action("snapshot")).preferences.theme === "system",
    );
    assert.equal((await appearance()).source, "system");
    // Playwright pins the page's prefers-color-scheme, so check the page's
    // choice against what the page itself sees rather than against macOS.
    assert.equal(
      await themeOf(panel),
      (await panel.evaluate(
        () => matchMedia("(prefers-color-scheme: dark)").matches,
      ))
        ? "night"
        : "warm",
    );
    await panel.getByRole("radio", { name: "暖阳小窝", exact: true }).click();
    await panel.waitForFunction(
      () => document.documentElement.dataset.theme === "warm",
    );
    assert.equal((await appearance()).source, "light");
    await panel.keyboard.press("Escape");
    console.log(
      "PASS: themes re-colour panel and pet, set macOS appearance and the window base, persist, follow the system; pet and unknown themes refused.",
    );
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
    const keys = await panel.evaluate(() =>
      window.otter.action("shortcuts.get"),
    );
    const registrations = await app.evaluate(
      ({ globalShortcut }, keys) => ({
        chat: globalShortcut.isRegistered(keys.chat),
        selection: globalShortcut.isRegistered(keys.selection),
      }),
      keys,
    );
    assert.equal(registrations.chat, keys.chatRegistered);
    assert.equal(registrations.selection, keys.selectionRegistered);
    console.log("Shortcut registration:", registrations);
    console.log(
      "Native selection permission:",
      await panel.evaluate(() =>
        window.otter.action("context.permission-status"),
      ),
    );
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(
      "PASS: real Electron report generation, persistence after reconnect, quiet setting, OpenAI model test/save/reconnect/generation/reset, streaming multi-turn chat, a read-only tool call answered mid-reply, explicit memory save/recall/correction/undo/clear, pet entry, cancel, history and deletion, local pet actions, head tap, sleep/wake, native menu wiring, live app awareness toggle/clear, IPC allowlist.",
    );
  } catch (error) {
    console.error(error);
    if (app) {
      const failurePanel = app
        .windows()
        .find((w) => w.url().includes("view=panel"));
      if (failurePanel)
        console.error(
          "Failure UI:",
          await failurePanel
            .locator("body")
            .ariaSnapshot()
            .catch(() => "unavailable"),
        );
    }
    throw error;
  } finally {
    if (app) await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(skillsHome, { recursive: true, force: true });
    sshd.stop();
    fs.rmSync(sshHome, { recursive: true, force: true });
    fs.rmSync(backdropDir, { recursive: true, force: true });
    execFileSync("/usr/bin/security", ["delete-keychain", sshKeychain]);
    if (keychains() !== keychainsBefore)
      console.error("The keychain search list changed during the smoke test.");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
