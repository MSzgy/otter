// Targeted real Electron smoke test. Uses isolated local mock data, no physical device.
const { _electron: electron } = require("playwright");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
(async () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "otter-evolution-smoke-"),
  );
  const userData = path.join(fixture, "user");
  fs.mkdirSync(userData);
  fs.writeFileSync(
    path.join(userData, "desktop.json"),
    JSON.stringify({
      quiet: true,
      hidden: true,
      body: { enabled: false },
      ambient: { enabled: false },
      shortcuts: { enabled: false },
    }),
  );
  const config = path.join(fixture, "config.toml");
  fs.writeFileSync(
    config,
    '[core]\ntimezone = "Asia/Shanghai"\n[identity]\nprimary = "evolution@otter.local"\n[llm]\nprovider = "mock"\n[llm.mock]\nresponse = "# 本机进化验收\\n\\n这是一份本机模拟简报。"\n',
  );
  const output =
    process.env.OTTER_EVOLUTION_OUTPUT ||
    path.join(
      os.homedir(),
      "Developer/otter-assets/otter-evolution-cinematic-v2/output",
    );
  fs.mkdirSync(output, { recursive: true });
  let app;
  const errors = [];
  async function launch() {
    app = await electron.launch({
      args: [path.resolve(__dirname, "..")],
      env: {
        ...process.env,
        OTTER_DESKTOP_USER_DATA: userData,
        OTTER_DESKTOP_CONFIG: config,
        OTTER_PROJECT_ROOT: fixture,
      },
      timeout: 30000,
    });
    let panel, pet;
    for (let i = 0; i < 100; i++) {
      panel = app.windows().find((w) => w.url().includes("view=panel"));
      pet = app.windows().find((w) => w.url().includes("view=pet"));
      if (panel && pet) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(panel && pet, "Expected panel and pet windows");
    panel.on("pageerror", (e) => errors.push(e.message));
    pet.on("pageerror", (e) => errors.push(e.message));
    await panel.waitForFunction(
      async () => !!(await window.otter.action("snapshot")).health,
      {},
      { timeout: 20000 },
    );
    return { panel, pet };
  }
  try {
    let { panel, pet } = await launch();
    await panel.getByRole("button", { name: "陪伴互动", exact: false }).click();
    await panel
      .getByRole("button", { name: "演示深潜流程", exact: true })
      .click();
    await panel.waitForFunction(
      async () =>
        (await window.otter.action("evolution.get")).demo?.phase === "waiting",
    );
    await panel.waitForTimeout(1000);
    let state = await panel.evaluate(() =>
      window.otter.action("evolution.get"),
    );
    assert.equal(state.demo.form, "deep");
    assert.equal(state.live.form, "companion");
    assert.equal(state.milestones.length, 0);
    await panel
      .getByRole("button", { name: "继续演示验证", exact: true })
      .click();
    await panel.waitForFunction(
      async () => !(await window.otter.action("evolution.get")).demo,
    );
    state = await panel.evaluate(() => window.otter.action("evolution.get"));
    assert.equal(state.lastCompleted, null);
    await panel
      .getByRole("button", { name: "演示工匠流程", exact: true })
      .click();
    await panel.getByRole("button", { name: "结束演示", exact: true }).click();
    await panel.waitForTimeout(4000);
    assert.equal(
      (await panel.evaluate(() => window.otter.action("evolution.get"))).demo,
      null,
    );
    await panel
      .getByRole("combobox", { name: "工作形态偏好", exact: true })
      .selectOption("deep");
    const session = await panel.evaluate(() => window.otter.call("chat.new"));
    const proposal = await panel.evaluate(
      ({ sessionId, requestId }) =>
        window.otter.action("tasks.plan", {
          text: "1小时后提醒我校验水獭进化",
          sessionId,
          requestId,
        }),
      { sessionId: session.id, requestId: randomUUID() },
    );
    assert.equal(proposal.kind, "proposal");
    await panel.evaluate(() => window.otter.action("evolution.skip"));
    assert.equal(
      (await panel.evaluate(() => window.otter.action("evolution.get"))).live
        .phase,
      "waiting",
      "Skip must not approve a real request",
    );
    state = await panel.evaluate(() => window.otter.action("evolution.get"));
    assert.equal(state.live.phase, "waiting");
    assert.equal(state.live.form, "deep");
    // The desktop pet has no form of its own: it follows the live state and
    // draws the evolved GIF, which loads on demand. Setting the canvas size
    // clears it, so opaque pixels under the deep form are the deep form's.
    await pet.waitForFunction(
      () => {
        const canvas = document.querySelector("canvas");
        if (canvas?.dataset.evolutionForm !== "deep") return false;
        const { data } = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height);
        let drawn = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 32) drawn++;
        return drawn > 1000;
      },
      {},
      { timeout: 8000 },
    );
    const petCanvas = await pet.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return {
        phase: canvas.dataset.evolutionPhase,
        label: canvas.getAttribute("aria-label"),
      };
    });
    assert.equal(petCanvas.phase, "waiting");
    assert.match(petCanvas.label, /深潜形态/);
    let assistant = await panel.evaluate(() =>
      window.otter.action("assistant.get"),
    );
    assert.equal(
      assistant.reminders.length,
      0,
      "Proposal must not create a reminder",
    );
    await panel
      .getByRole("button", { name: "演示深潜流程", exact: true })
      .click();
    await panel.waitForFunction(
      async () =>
        (await window.otter.action("evolution.get")).demo?.phase === "waiting",
    );
    await panel
      .getByRole("button", { name: "继续演示验证", exact: true })
      .click();
    await panel.waitForFunction(
      async () => !(await window.otter.action("evolution.get")).demo,
    );
    assistant = await panel.evaluate(() =>
      window.otter.action("assistant.get"),
    );
    assert.equal(
      assistant.reminders.length,
      0,
      "Demo must not confirm a real request",
    );
    state = await panel.evaluate(() => window.otter.action("evolution.get"));
    assert.equal(state.live.phase, "waiting");
    assert.equal(state.lastCompleted, null);
    const result = await panel.evaluate(
      ({ id, sessionId }) =>
        window.otter.action("tasks.confirm", { id, sessionId }),
      { id: proposal.id, sessionId: session.id },
    );
    assert.equal(result.ok, true);
    state = await panel.evaluate(() => window.otter.action("evolution.get"));
    assert.equal(state.live.phase, "success");
    assert.equal(state.milestones.length, 0);
    await panel
      .getByRole("button", { name: "记下这次完成", exact: true })
      .click();
    state = await panel.evaluate(() => window.otter.action("evolution.get"));
    assert.equal(state.milestones.length, 1);
    await panel.evaluate(
      (id) => window.otter.action("evolution.milestone", { id }),
      state.lastCompleted.id,
    );
    assert.equal(
      (await panel.evaluate(() => window.otter.action("evolution.get")))
        .milestones.length,
      1,
      "Milestone must deduplicate",
    );
    const denied = await pet.evaluate(async () => {
      try {
        await window.otter.action("evolution.configure", {
          enabled: false,
          mode: "auto",
        });
        return false;
      } catch {
        return true;
      }
    });
    assert(denied, "Pet window must not mutate settings");
    await panel.waitForFunction(
      async () =>
        (await window.otter.action("evolution.get")).live.form === "companion",
    );
    const modelBefore = await panel.evaluate(() =>
      window.otter.action("snapshot"),
    );
    await panel.evaluate(
      (day) =>
        window.otter.call("reports.generate", { date: day, collect: false }),
      modelBefore.health.today,
    );
    await panel.waitForFunction(
      async () =>
        (await window.otter.action("evolution.get")).lastCompleted?.kind ===
        "report",
      {},
      { timeout: 15000 },
    );
    const reportState = await panel.evaluate(() =>
      window.otter.action("evolution.get"),
    );
    assert.equal(reportState.live.form, "deep");
    await panel
      .getByRole("button", { name: "记下这次完成", exact: true })
      .click();
    const modelAfter = await panel.evaluate(() =>
      window.otter.action("snapshot"),
    );
    assert.equal(modelAfter.health.provider, modelBefore.health.provider);
    assert.equal(modelAfter.health.model, modelBefore.health.model);
    assert.equal(
      (await panel.evaluate(() => window.otter.action("evolution.get")))
        .milestones.length,
      2,
    );
    await panel.locator("main").evaluate((el) => {
      el.scrollTop = 0;
    });
    await panel.screenshot({
      path: path.join(output, "electron-evolution.png"),
      fullPage: true,
    });
    await app.close();
    app = null;
    ({ panel, pet } = await launch());
    state = await panel.evaluate(() => window.otter.action("evolution.get"));
    assert.equal(state.milestones.length, 2);
    assert.equal(state.settings.mode, "deep");
    assert.equal(state.live.form, "companion");
    assert.equal(errors.length, 0, errors.join("\n"));
    const report = {
      status: "passed",
      real_electron: true,
      isolated_mock_backend: true,
      demo_cannot_approve_real_task: true,
      real_task_wait_and_success: true,
      desktop_pet_follows_live_form: true,
      real_report_completion: true,
      milestone_requires_explicit_confirmation: true,
      milestone_deduplication: true,
      milestones_persist_after_restart: true,
      model_settings_unchanged: true,
      pet_mutation_denied: true,
      hardware_contacted: false,
    };
    fs.writeFileSync(
      path.join(output, "electron-verification.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (app) await app.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
