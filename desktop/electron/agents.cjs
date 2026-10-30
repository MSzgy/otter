// AI 代理: hand a task to a coding agent on this Mac and hear back when it is
// done. Codex is the only agent so far; Claude Code or Grok join by adding an
// adapter to the list main.cjs passes in. An adapter is
//
//   { id, label,
//     detect() → { ok, path, version, login, reason },
//     run(task, { onEvent, signal }) → { ok, text, changes, usage, error, threadId } }
//
// where task is { prompt, cwd, access: "read" | "write" } and onEvent(line)
// reports what the agent is doing in a few words. AgentTasks keeps the list
// (running ones are lost when Otter quits: they come back "interrupted"),
// runs at most a few at once, and calls onFinish when one ends.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const MAX_RUNNING = 3;
const KEEP = 50;
const MAX_PROMPT = 20000;
const MAX_TEXT = 20000;
const MAX_CHANGES = 50;
const TIMEOUT = 60 * 60 * 1000;
const STATUS = {
  running: "进行中",
  done: "已完成",
  failed: "没做完",
  stopped: "已停止",
  interrupted: "已中断",
};
const ACCESS = {
  read: "只读：只能查看和分析，不改文件",
  write: "可以修改这个文件夹里的文件（不联网）",
};

const clip = (text, limit) =>
  text.length > limit ? `${text.slice(0, limit)}\n…（后面省略）` : text;
const tail = (text, lines) => text.trim().split("\n").slice(-lines).join("\n");
const short = (p, home = os.homedir()) =>
  p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;

function find(name, PATH) {
  for (const dir of PATH.split(":")) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not in this folder
    }
  }
  return null;
}
// A changed file as shown in reports: relative to the task's folder (which
// may be reached through a symlink, like /tmp), or absolute when outside it.
function relative(cwd, file) {
  for (const base of [cwd, realpath(cwd)]) {
    const rel = path.relative(base, path.resolve(base, file));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return path.resolve(cwd, file);
}
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
// What git sees as changed under a folder: absolute path → a signature that
// moves when the file does. null outside a git work tree (or when there is
// too much to compare). Any agent's edits show up here, shell or patch.
function gitState(cwd) {
  return new Promise((resolve) =>
    execFile(
      "/usr/bin/git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { timeout: 10000 },
      (error, top) => {
        if (error) return resolve(null);
        const root = String(top).trim();
        execFile(
          "/usr/bin/git",
          [
            "-C",
            cwd,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ],
          { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
          (error, out) => {
            if (error) return resolve(null);
            const parts = String(out).split("\0");
            if (parts.length > 4000) return resolve(null);
            const inside = realpath(cwd) + path.sep;
            const state = new Map();
            for (let i = 0; i < parts.length; i++) {
              if (parts[i].length < 4) continue;
              const status = parts[i].slice(0, 2);
              const file = path.join(root, parts[i].slice(3));
              // A rename or copy is followed by its old name.
              if (/[RC]/.test(status[0])) i++;
              if (!file.startsWith(inside)) continue;
              let mark = "gone";
              try {
                const stat = fs.statSync(file);
                mark = `${stat.size}:${stat.mtimeMs}`;
              } catch {
                // deleted
              }
              state.set(file, `${status}:${mark}`);
            }
            resolve(state);
          },
        );
      },
    ),
  );
}
function run(file, args, env, timeout = 10000) {
  return new Promise((resolve) =>
    execFile(file, args, { env, timeout }, (error, stdout = "", stderr = "") =>
      resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );
}

// Codex CLI: `codex exec --json`, prompt on stdin, its own sandbox
// (read-only or workspace-write, which keeps the network off), the final
// message written to a file. Warnings arrive as items of type "error" and are
// not failures; turn.failed and a top-level error are.
function codexAgent({ bin = null, PATH: pathFor, tmp = os.tmpdir() } = {}) {
  const env = async () => ({
    ...process.env,
    PATH: await pathFor(),
    NO_COLOR: "1",
  });
  const where = async () => bin || find("codex", (await env()).PATH);
  // What each event means for the one-line progress shown in the app.
  function describe(event, state) {
    const item = event.item || {};
    if (event.type === "thread.started") state.threadId = event.thread_id;
    if (event.type === "turn.started") return "开始工作";
    if (event.type === "turn.completed") state.usage = event.usage || null;
    if (event.type === "turn.failed")
      state.error = event.error?.message || "Codex 报告任务失败。";
    if (event.type === "error") state.error = event.message || "Codex 出错了。";
    if (!/^item\./.test(event.type)) return null;
    const done = event.type === "item.completed";
    if (item.type === "command_execution" && !done) {
      // Codex wraps commands in a login shell; show what runs inside.
      const command = String(item.command || "");
      const inner = /^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(command);
      return `运行 ${(inner ? inner[2] : command).slice(0, 120)}`;
    }
    if (item.type === "command_execution" && done && item.exit_code)
      return `命令退出码 ${item.exit_code}`;
    if (item.type === "file_change" && done) {
      for (const c of item.changes || [])
        if (c?.path && !state.changes.includes(c.path))
          state.changes.push(c.path);
      return `改了 ${(item.changes || []).map((c) => path.basename(c.path || "")).join("、")}`;
    }
    if (item.type === "agent_message" && done) {
      state.text = String(item.text || "");
      return `说：${state.text.trim().split("\n")[0].slice(0, 80)}`;
    }
    if (item.type === "reasoning") return "思考中";
    if (item.type === "web_search") return `搜索 ${item.query || ""}`.trim();
    if (item.type === "mcp_tool_call" && !done)
      return `调用 ${[item.server, item.tool].filter(Boolean).join(".")}`;
    if (item.type === "todo_list") {
      const items = item.items || [];
      return `计划 ${items.filter((i) => i.completed).length}/${items.length}`;
    }
    return null;
  }
  return {
    id: "codex",
    label: "Codex",
    async detect() {
      const file = await where();
      if (!file)
        return {
          ok: false,
          reason:
            "没找到 codex 命令。先在终端安装 Codex CLI（brew install codex 或 npm i -g @openai/codex），再运行 codex login 登录。",
        };
      const e = await env();
      const version = await run(file, ["--version"], e);
      if (version.error)
        return {
          ok: false,
          path: file,
          reason: `codex 运行不了：${tail(version.stderr || version.error.message, 2)}`,
        };
      const login = await run(file, ["login", "status"], e);
      const status = tail(`${login.stdout}\n${login.stderr}`, 1);
      return {
        ok: !login.error,
        path: file,
        version: version.stdout.trim(),
        login: login.error ? "" : status,
        reason: login.error
          ? "Codex 还没登录。在终端运行 codex login 登录后再试。"
          : "",
      };
    },
    async run(task, { onEvent = () => {}, signal } = {}) {
      const file = await where();
      if (!file) throw new Error("没找到 codex 命令。");
      const out = path.join(tmp, `otter-codex-${randomUUID()}.txt`);
      const child = spawn(
        file,
        [
          "exec",
          "--json",
          "--color",
          "never",
          "--skip-git-repo-check",
          "--sandbox",
          task.access === "write" ? "workspace-write" : "read-only",
          "--cd",
          task.cwd,
          "--output-last-message",
          out,
          "-",
        ],
        {
          cwd: task.cwd,
          env: await env(),
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const state = { changes: [], text: "", error: "", usage: null };
      let stderr = "";
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          try {
            const said = describe(JSON.parse(line), state);
            if (said) onEvent(said);
          } catch {
            // not an event line
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-8000);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(task.prompt);
      const stop = () => {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          return;
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }, 5000).unref();
      };
      if (signal?.aborted) stop();
      signal?.addEventListener("abort", stop, { once: true });
      const code = await new Promise((resolve) => {
        child.on("error", (e) => {
          state.error ||= e.message;
          resolve(-1);
        });
        child.on("close", (c) => resolve(c));
      });
      signal?.removeEventListener("abort", stop);
      let last = "";
      try {
        last = fs.readFileSync(out, "utf8").trim();
      } catch {
        // no final message
      }
      fs.rmSync(out, { force: true });
      const text = clip(last || state.text, MAX_TEXT);
      const ok = code === 0 && !state.error;
      return {
        ok,
        text,
        changes: state.changes.slice(0, MAX_CHANGES),
        usage: state.usage,
        threadId: state.threadId || "",
        error: ok
          ? ""
          : state.error ||
            (tail(stderr, 4)
              ? `Codex 退出码 ${code}：${tail(stderr, 4)}`
              : `Codex 退出码 ${code}`),
      };
    },
  };
}

class AgentTasks {
  constructor({
    adapters,
    load = () => null,
    save = () => {},
    onChange = () => {},
    onFinish = () => {},
    home = os.homedir(),
    timeout = TIMEOUT,
    now = Date.now,
  }) {
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
    this.save = save;
    this.onChange = onChange;
    this.onFinish = onFinish;
    this.home = home;
    this.timeout = timeout;
    this.now = now;
    this.running = new Map();
    this.found = new Map();
    const saved = load() || {};
    this.defaultFolder =
      typeof saved.defaultFolder === "string" ? saved.defaultFolder : "";
    // A task that was running when Otter quit cannot be picked up again.
    this.tasks = (Array.isArray(saved.tasks) ? saved.tasks : [])
      .filter(
        (t) => t && typeof t.id === "string" && this.adapters.has(t.agent),
      )
      .slice(0, KEEP)
      .map((t) =>
        t.status === "running"
          ? {
              ...t,
              status: "interrupted",
              ended: t.ended || this.now(),
              error: "Otter 退出时任务还没做完。",
            }
          : t,
      );
  }
  persist() {
    this.save({
      defaultFolder: this.defaultFolder,
      tasks: this.tasks.map(({ progress, ...t }) => t),
    });
  }
  changed() {
    clearTimeout(this.pending);
    this.pending = null;
    this.onChange(this.snapshot());
  }
  // Progress comes in bursts; the app hears about it a few times a second.
  soon() {
    this.pending ||= setTimeout(() => this.changed(), 300);
  }
  snapshot() {
    return {
      agents: [...this.adapters.values()].map((a) => ({
        id: a.id,
        label: a.label,
        ...(this.found.get(a.id) || { checked: false }),
      })),
      defaultFolder: this.defaultFolder,
      tasks: this.tasks.map((t) => ({ ...t, statusText: STATUS[t.status] })),
    };
  }
  label(id) {
    return this.adapters.get(id)?.label || id;
  }
  async detect(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error("没有这个 AI 代理。");
    let found;
    try {
      found = await adapter.detect();
    } catch (e) {
      found = { ok: false, reason: e.message };
    }
    this.found.set(id, { checked: true, ...found });
    this.changed();
    return found;
  }
  // Before a card: an agent that was missing is looked for again (it may
  // have been installed since), and one still missing says what to do.
  async ready(id) {
    if (!this.adapters.has(id) || this.found.get(id)?.ok) return;
    const found = await this.detect(id);
    if (!found.ok)
      throw new Error(found.reason || `${this.label(id)} 现在用不了。`);
  }
  async detectAll() {
    for (const id of this.adapters.keys()) await this.detect(id);
    return this.snapshot();
  }
  setDefaultFolder(folder) {
    this.defaultFolder = folder ? this.folder(folder) : "";
    this.persist();
    this.changed();
    return this.snapshot();
  }
  // A folder the agent may work in: it exists, and it is not the whole disk
  // or (for writing) the whole home folder.
  folder(value, access = "read") {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("请说明让代理在哪个文件夹里工作。");
    const dir = path.resolve(
      raw === "~"
        ? this.home
        : raw.startsWith("~/")
          ? path.join(this.home, raw.slice(2))
          : raw,
    );
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      throw new Error(`找不到文件夹：${raw}`);
    }
    if (!stat.isDirectory()) throw new Error(`这不是文件夹：${raw}`);
    if (dir === path.parse(dir).root)
      throw new Error("不能把整个磁盘交给代理，请指定一个项目文件夹。");
    if (access === "write" && dir === path.resolve(this.home))
      throw new Error("不能让代理改整个用户文件夹，请指定一个项目文件夹。");
    return dir;
  }
  // Checks a request and fills in the default folder; used for the card too.
  check({ agent, prompt, folder, access, title }) {
    const adapter = this.adapters.get(agent);
    if (!adapter)
      throw new Error(
        `目前只能交给 ${[...this.adapters.values()].map((a) => a.label).join("、")}。`,
      );
    if (typeof prompt !== "string" || !prompt.trim())
      throw new Error("缺少任务内容。");
    if (prompt.length > MAX_PROMPT) throw new Error("任务描述太长了。");
    if (!ACCESS[access])
      throw new Error("权限只能是只读（read）或可改文件（write）。");
    if (!folder && !this.defaultFolder)
      throw new Error(
        "请说明让代理在哪个文件夹里工作，或者在 设置 → AI 代理 里设一个默认文件夹。",
      );
    const cwd = this.folder(folder || this.defaultFolder, access);
    const name =
      (typeof title === "string" && title.trim()) ||
      prompt.trim().split("\n")[0];
    return {
      agent,
      label: adapter.label,
      prompt: prompt.trim(),
      cwd,
      access,
      title: name.slice(0, 60),
    };
  }
  describe(request) {
    const r = this.check(request);
    return [
      `交给 ${r.label}：${r.title}`,
      `文件夹：${short(r.cwd, this.home)}`,
      `权限：${ACCESS[r.access]}`,
      "",
      "任务：",
      r.prompt,
      "",
      `${r.label} 会在后台做，做完后结果会自动发回这个对话。`,
    ].join("\n");
  }
  start(request, { sessionId = "" } = {}) {
    const r = this.check(request);
    if (this.running.size >= MAX_RUNNING)
      throw new Error(`已经有 ${MAX_RUNNING} 个任务在做，等一个做完再派。`);
    const task = {
      id: randomUUID().slice(0, 8),
      agent: r.agent,
      title: r.title,
      prompt: r.prompt,
      cwd: r.cwd,
      access: r.access,
      sessionId,
      status: "running",
      created: this.now(),
      ended: null,
      progress: "准备中",
      result: "",
      changes: [],
      error: "",
      threadId: "",
    };
    this.tasks.unshift(task);
    for (const old of this.tasks.splice(KEEP))
      this.running.get(old.id)?.abort();
    this.persist();
    this.changed();
    void this.work(task);
    return { ...task };
  }
  async work(task) {
    const controller = new AbortController();
    this.running.set(task.id, controller);
    const timer = setTimeout(() => {
      task.timedOut = true;
      controller.abort();
    }, this.timeout);
    let result;
    const before = task.access === "write" ? await gitState(task.cwd) : null;
    try {
      result = await this.adapters.get(task.agent).run(
        { prompt: task.prompt, cwd: task.cwd, access: task.access },
        {
          signal: controller.signal,
          onEvent: (line) => {
            task.progress = line;
            this.soon();
          },
        },
      );
    } catch (e) {
      result = { ok: false, text: "", changes: [], error: e.message };
    } finally {
      clearTimeout(timer);
      this.running.delete(task.id);
    }
    const stopped = controller.signal.aborted;
    const changes = new Set(
      (result.changes || []).map((f) => relative(task.cwd, f)),
    );
    const after = before && (await gitState(task.cwd));
    if (after)
      for (const [file, mark] of after)
        if (before.get(file) !== mark) changes.add(relative(task.cwd, file));
    Object.assign(task, {
      status: result.ok
        ? "done"
        : stopped && !task.timedOut
          ? "stopped"
          : "failed",
      ended: this.now(),
      result: result.text || "",
      changes: [...changes].slice(0, MAX_CHANGES),
      threadId: result.threadId || "",
      usage: result.usage || null,
      error: result.ok
        ? ""
        : task.timedOut
          ? `超过 ${Math.round(this.timeout / 60000)} 分钟，已停止。`
          : stopped
            ? "按你的要求停下了。"
            : result.error || "没有说明原因。",
    });
    delete task.progress;
    delete task.timedOut;
    this.persist();
    this.changed();
    try {
      await this.onFinish({ ...task });
    } catch {
      // the list still has it
    }
  }
  stop(id) {
    const controller = this.running.get(id);
    if (!controller) throw new Error("这个任务已经不在进行中了。");
    controller.abort();
    return this.snapshot();
  }
  remove(id) {
    if (this.running.has(id)) throw new Error("任务还在进行中，先停止它。");
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.persist();
    this.changed();
    return this.snapshot();
  }
  clearFinished() {
    this.tasks = this.tasks.filter((t) => this.running.has(t.id));
    this.persist();
    this.changed();
    return this.snapshot();
  }
  stopAll() {
    for (const controller of this.running.values()) controller.abort();
  }
}

// The chat message a finished task leaves in its conversation.
function report(task, label, home = os.homedir()) {
  const seconds = Math.max(
    0,
    Math.round(((task.ended || 0) - task.created) / 1000),
  );
  const took =
    seconds >= 60
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`;
  const shown = (f) => (path.isAbsolute(f) ? short(f, home) : f);
  const head =
    task.status === "done"
      ? `**${label} 做完了：${task.title}**`
      : task.status === "stopped"
        ? `**已停止 ${label} 的任务：${task.title}**`
        : `**${label} 没做完：${task.title}**`;
  const files = task.changes.length
    ? `改动的文件（${task.changes.length} 个）：${task.changes
        .slice(0, 12)
        .map((f) => `\`${shown(f)}\``)
        .join("、")}${task.changes.length > 12 ? " 等" : ""}`
    : "";
  return [
    head,
    task.status === "done" ? "" : `原因：${task.error}`,
    task.result,
    files,
    `用时 ${took} · ${short(task.cwd, home)} · ${task.access === "write" ? "可改文件" : "只读"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

module.exports = { AgentTasks, codexAgent, report, ACCESS, STATUS, short };
