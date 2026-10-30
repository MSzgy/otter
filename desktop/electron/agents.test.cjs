const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentTasks, codexAgent, report } = require("./agents.cjs");

const fake = path.resolve(__dirname, "../scripts/fake-codex.cjs");
fs.chmodSync(fake, 0o755);
const PATH = async () => process.env.PATH;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "otter-agents-home-"));
const project = path.join(home, "project");
fs.mkdirSync(project);
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function logged(fn) {
  const log = path.join(home, `log-${Math.random()}.jsonl`);
  process.env.FAKE_CODEX_LOG = log;
  return fn()
    .finally(() => delete process.env.FAKE_CODEX_LOG)
    .then((r) => ({
      result: r,
      calls: fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    }));
}
function tasks(extra = {}) {
  const saved = [];
  const finished = [];
  const changes = [];
  const store = new AgentTasks({
    adapters: [codexAgent({ bin: fake, PATH })],
    home,
    save: (v) => saved.push(structuredClone(v)),
    onChange: (v) => changes.push(v),
    onFinish: (t) => finished.push(t),
    ...extra,
  });
  const done = (n = 1) =>
    new Promise((resolve) => {
      const wait = () =>
        finished.length >= n ? resolve(finished) : setTimeout(wait, 20);
      wait();
    });
  return { store, saved, finished, changes, done };
}

test("detect finds codex, its version and login, or says what is missing", async () => {
  const found = await codexAgent({ bin: fake, PATH }).detect();
  assert.equal(found.ok, true);
  assert.equal(found.version, "codex-cli 0.166.0-fake");
  assert.equal(found.login, "Logged in using ChatGPT");
  process.env.FAKE_CODEX_LOGGED_OUT = "1";
  const out = await codexAgent({ bin: fake, PATH }).detect();
  delete process.env.FAKE_CODEX_LOGGED_OUT;
  assert.equal(out.ok, false);
  assert.match(out.reason, /codex login/);
  const missing = await codexAgent({
    PATH: async () => "/nonexistent",
  }).detect();
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /没找到 codex 命令/);
});

test("a writing task runs codex exec in its sandbox with the prompt on stdin", async () => {
  const prompt = "--help\nresume 在 README 里加一行说明";
  const { result, calls } = await logged(() =>
    codexAgent({ bin: fake, PATH }).run({
      prompt,
      cwd: project,
      access: "write",
    }),
  );
  const [{ args, cwd }, { prompt: received }] = calls;
  assert.equal(received, prompt, "the prompt arrives whole, never as options");
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(project));
  assert.deepEqual(args.slice(0, 6), [
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--sandbox",
  ]);
  assert.equal(args[6], "workspace-write");
  assert.equal(args[args.indexOf("--cd") + 1], project);
  assert.equal(args.at(-1), "-");
  assert(!args.some((a) => /dangerously|full-access/.test(a)));
  assert.equal(result.ok, true);
  assert.equal(result.text, "做好了。写了 otter-agent.txt。");
  assert.deepEqual(result.changes, [path.join(project, "otter-agent.txt")]);
  assert.equal(result.threadId, "fake-thread-1");
  assert.equal(result.usage.output_tokens, 10);
  assert.equal(
    fs.readFileSync(path.join(project, "otter-agent.txt"), "utf8"),
    prompt,
  );
  fs.rmSync(path.join(project, "otter-agent.txt"));
});

test("a read-only task asks for the read-only sandbox; failures say why", async () => {
  const agent = codexAgent({ bin: fake, PATH });
  const { result, calls } = await logged(() =>
    agent.run({ prompt: "看看", cwd: project, access: "read" }),
  );
  assert.equal(
    calls[0].args[calls[0].args.indexOf("--sandbox") + 1],
    "read-only",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, []);
  assert.equal(fs.existsSync(path.join(project, "otter-agent.txt")), false);
  const failed = await agent.run({
    prompt: "做不完",
    cwd: project,
    access: "read",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "模型额度用完了");
});

test("a task runs in the background, reports progress, and ends with a report", async () => {
  const { store, saved, finished, done } = tasks();
  const started = store.start(
    {
      agent: "codex",
      prompt: "写个文件",
      folder: "~/project",
      access: "write",
      title: "写文件",
    },
    { sessionId: "s1" },
  );
  assert.equal(started.status, "running");
  assert.equal(started.cwd, project);
  assert.equal(started.sessionId, "s1");
  await done();
  const [task] = finished;
  assert.equal(task.status, "done");
  assert.equal(task.result, "做好了。写了 otter-agent.txt。");
  assert.deepEqual(task.changes, ["otter-agent.txt"]);
  const last = saved.at(-1).tasks[0];
  assert.equal(last.status, "done");
  assert.equal("progress" in last, false, "progress is not saved");
  const text = report(task, "Codex", home);
  assert.match(text, /^\*\*Codex 做完了：写文件\*\*/);
  assert.match(text, /改动的文件（1 个）：`otter-agent\.txt`/);
  assert.match(text, /用时 \d+ 秒 · ~\/project · 可改文件$/);
  fs.rmSync(path.join(project, "otter-agent.txt"));
});

test("stop ends a running task and its process; a timeout fails it", async () => {
  const { store, finished, changes, done } = tasks();
  const t = store.start({
    agent: "codex",
    prompt: "慢慢做",
    folder: project,
    access: "read",
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(store.snapshot().tasks[0].status, "running");
  assert.match(changes.at(-1).tasks[0].progress, /^运行 step \d+$/);
  store.stop(t.id);
  await done();
  assert.equal(finished[0].status, "stopped");
  assert.equal(finished[0].error, "按你的要求停下了。");
  assert.match(
    report(finished[0], "Codex", home),
    /^\*\*已停止 Codex 的任务：慢慢做\*\*/,
  );
  assert.throws(() => store.stop(t.id), /不在进行中/);
  const slow = tasks({ timeout: 300 });
  slow.store.start({
    agent: "codex",
    prompt: "慢慢做",
    folder: project,
    access: "read",
  });
  await slow.done();
  assert.equal(slow.finished[0].status, "failed");
  assert.match(slow.finished[0].error, /超过 0 分钟|超过 \d+ 分钟/);
});

test("requests are checked before anything runs", () => {
  const { store } = tasks();
  const base = {
    agent: "codex",
    prompt: "做点事",
    folder: project,
    access: "write",
  };
  for (const [change, error] of [
    [{ agent: "claude" }, /目前只能交给 Codex/],
    [{ prompt: " " }, /缺少任务内容/],
    [{ prompt: "x".repeat(20001) }, /太长/],
    [{ access: "full" }, /权限只能是/],
    [{ folder: "" }, /哪个文件夹/],
    [{ folder: path.join(home, "nope") }, /找不到文件夹/],
    [{ folder: fake }, /这不是文件夹/],
    [{ folder: "/" }, /整个磁盘/],
    [{ folder: "~" }, /整个用户文件夹/],
  ])
    assert.throws(() => store.check({ ...base, ...change }), error);
  assert.equal(store.check({ ...base, folder: "~", access: "read" }).cwd, home);
  store.setDefaultFolder("~/project");
  assert.equal(store.check({ ...base, folder: "" }).cwd, project);
  assert.equal(store.check(base).title, "做点事");
  assert.equal(
    store.describe({ ...base, title: "改 README" }),
    [
      "交给 Codex：改 README",
      "文件夹：~/project",
      "权限：可以修改这个文件夹里的文件（不联网）",
      "",
      "任务：",
      "做点事",
      "",
      "Codex 会在后台做，做完后结果会自动发回这个对话。",
    ].join("\n"),
  );
});

test("at most three run at once; finished ones can be removed", async () => {
  const { store, done } = tasks();
  const slow = {
    agent: "codex",
    prompt: "慢慢做",
    folder: project,
    access: "read",
  };
  const ids = [0, 1, 2].map(() => store.start(slow).id);
  assert.throws(() => store.start(slow), /已经有 3 个任务在做/);
  assert.throws(() => store.remove(ids[0]), /先停止/);
  for (const id of ids) store.stop(id);
  await done(3);
  store.remove(ids[0]);
  assert.equal(store.snapshot().tasks.length, 2);
  store.clearFinished();
  assert.equal(store.snapshot().tasks.length, 0);
});

test("tasks that were running when Otter quit come back interrupted", () => {
  const { store } = tasks({
    load: () => ({
      defaultFolder: project,
      tasks: [
        { id: "a", agent: "codex", status: "running", created: 1, changes: [] },
        { id: "b", agent: "codex", status: "done", created: 1, changes: [] },
        { id: "c", agent: "grok", status: "done", created: 1, changes: [] },
        null,
      ],
    }),
  });
  const snap = store.snapshot();
  assert.deepEqual(
    snap.tasks.map((t) => [t.id, t.status, t.statusText]),
    [
      ["a", "interrupted", "已中断"],
      ["b", "done", "已完成"],
    ],
  );
  assert.equal(snap.tasks[0].error, "Otter 退出时任务还没做完。");
  assert.equal(snap.defaultFolder, project);
  assert.deepEqual(snap.agents, [
    { id: "codex", label: "Codex", checked: false },
  ]);
});

test("changes are found through git too, whoever made them", async () => {
  const { execFileSync } = require("node:child_process");
  const repo = path.join(home, "repo");
  fs.mkdirSync(path.join(repo, "app"), { recursive: true });
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", repo, ...args]);
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "app", "kept.txt"), "1");
  fs.writeFileSync(path.join(repo, "app", "dirty.txt"), "1");
  fs.writeFileSync(path.join(repo, "outside.txt"), "1");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  // Already dirty before the task, and left alone by it: not reported.
  fs.writeFileSync(path.join(repo, "app", "dirty.txt"), "before");
  const shellAgent = {
    id: "shell",
    label: "Shell",
    detect: async () => ({ ok: true }),
    run: async ({ cwd }) => {
      fs.writeFileSync(
        path.join(cwd, "kept.txt"),
        "changed by a shell command",
      );
      fs.writeFileSync(path.join(cwd, "fresh.txt"), "new");
      fs.writeFileSync(path.join(repo, "outside.txt"), "not in the folder");
      return { ok: true, text: "好了", changes: [] };
    },
  };
  const finished = [];
  const store = new AgentTasks({
    adapters: [shellAgent],
    home,
    onFinish: (t) => finished.push(t),
  });
  store.start({
    agent: "shell",
    prompt: "改",
    folder: path.join(repo, "app"),
    access: "write",
  });
  while (!finished.length) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(finished[0].changes.sort(), ["fresh.txt", "kept.txt"]);
});

test("progress reads like what the agent is doing", async () => {
  const lines = [];
  const agent = codexAgent({ bin: fake, PATH });
  await agent.run(
    { prompt: "看看", cwd: project, access: "read" },
    { onEvent: (l) => lines.push(l) },
  );
  assert.deepEqual(lines, [
    "开始工作",
    "运行 ls",
    "说：做好了。只看了文件，没有改动。",
  ]);
});

test("an agent that is missing is looked for again, then explained", async () => {
  let installed = false;
  const store = new AgentTasks({
    adapters: [
      {
        id: "later",
        label: "Later",
        detect: async () =>
          installed ? { ok: true } : { ok: false, reason: "先安装 later。" },
      },
    ],
    home,
  });
  await assert.rejects(store.ready("later"), /先安装 later。/);
  installed = true;
  await store.ready("later");
  assert.equal(store.snapshot().agents[0].ok, true);
});
