const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SkillLibrary, frontMatter } = require("./skills.cjs");

function write(dir, folder, text, extra = {}) {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, folder, "SKILL.md"), text);
  for (const [name, body] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, folder, name)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, folder, name), body);
  }
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otter-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let stored = {};
  const lib = new SkillLibrary({
    dir: path.join(root, "skills"),
    load: () => stored,
    save: (v) => (stored = v),
  });
  return { root, dir: lib.dir, lib };
}
const haiku = `---
name: haiku
description: 写一首中文俳句时用
---
按 5-7-5 写三行。`;

test("front matter: plain, quoted and block values", () => {
  const { meta, body } = frontMatter(
    '---\nname: "a b"\ndescription: |\n  第一行\n  第二行\nother: x\n---\n正文',
  );
  assert.deepEqual(meta, {
    name: "a b",
    description: "第一行\n第二行",
    other: "x",
  });
  assert.equal(body, "正文");
  assert.deepEqual(frontMatter("no header").meta, {});
});

test("scan finds skills, explains broken ones, and offers two read-only tools", async (t) => {
  const { dir, lib } = setup(t);
  write(dir, "haiku", haiku, {
    "examples/1.md": "古池や",
    "run.sh": "rm -rf /",
  });
  write(dir, "broken", "---\nname: broken\n---\n没有 description");
  write(dir, "zz-copy", haiku);
  const state = lib.scan();
  assert.deepEqual(state.items, [
    {
      name: "haiku",
      description: "写一首中文俳句时用",
      folder: "haiku",
      source: "otter",
      alsoIn: [],
      builtin: false,
      enabled: true,
      active: true,
    },
  ]);
  assert.deepEqual(state.problems.map((p) => p.folder).sort(), [
    "broken",
    "zz-copy",
  ]);
  const [use, read] = lib.source().list();
  assert.equal(use.name, "use_skill");
  assert(use.readOnly && use.trusted);
  assert.deepEqual(use.parameters.properties.name.enum, ["haiku"]);
  assert.match(
    use.parameters.properties.name.description,
    /haiku：写一首中文俳句时用/,
  );
  const loaded = await use.run({ name: "haiku" });
  assert.match(loaded, /# Skill：haiku/);
  assert.match(loaded, /按 5-7-5 写三行。/);
  assert.match(loaded, /- examples\/1\.md/);
  assert.match(loaded, /脚本不会运行/);
  assert.equal(
    await read.run({ name: "haiku", file: "examples/1.md" }),
    "古池や",
  );
  assert.throws(
    () => read.run({ name: "haiku", file: "../broken/SKILL.md" }),
    /只能读/,
  );
  assert.throws(
    () => read.run({ name: "haiku", file: "/etc/hosts" }),
    /只能读/,
  );
});

test("a disabled skill disappears from the tools; none left means no tools", (t) => {
  const { dir, lib } = setup(t);
  write(dir, "haiku", haiku);
  lib.scan();
  lib.setEnabled("haiku", false);
  assert.equal(lib.snapshot().items[0].enabled, false);
  assert.deepEqual(lib.source().list(), []);
  lib.setEnabled("haiku", true);
  assert.equal(lib.source().list().length, 2);
  assert.throws(() => lib.setEnabled("nope", true), /没有这个 skill/);
});

test("import copies a folder with a valid SKILL.md, once", (t) => {
  const { root, lib } = setup(t);
  lib.scan();
  const source = path.join(root, "from", "haiku");
  write(path.dirname(source), "haiku", haiku, { "notes.md": "x" });
  assert.equal(lib.import(source).items[0].name, "haiku");
  assert(fs.existsSync(path.join(lib.dir, "haiku", "notes.md")));
  assert.throws(() => lib.import(source), /已经有/);
  const bad = path.join(root, "from", "bad");
  write(path.dirname(bad), "bad", "no front matter");
  assert.throws(() => lib.import(bad), /缺少 name 或 description/);
});

test("skills shipped with the app sit beside the user's, and win a name clash", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otter-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shipped = path.join(root, "shipped");
  write(
    shipped,
    "add-mcp",
    "---\nname: add-mcp-server\ndescription: 添加 MCP\n---\n做法",
  );
  const lib = new SkillLibrary({
    dir: path.join(root, "user"),
    builtin: shipped,
    load: () => ({}),
    save: () => {},
  });
  write(lib.dir, "mine", haiku);
  write(
    lib.dir,
    "copy",
    "---\nname: add-mcp-server\ndescription: 我的版本\n---\nx",
  );
  const state = lib.scan();
  assert.deepEqual(
    state.items.map((i) => [i.name, i.builtin]),
    [
      ["add-mcp-server", true],
      ["haiku", false],
    ],
  );
  assert.match(state.problems[0].message, /和自带的 skill 重名/);
  const missing = new SkillLibrary({
    dir: path.join(root, "u2"),
    builtin: path.join(root, "nowhere"),
    load: () => ({}),
    save: () => {},
  });
  assert.deepEqual(missing.scan().items, []);
});

test("other tools' folders: read in place, merged when shared, each with a switch", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "otter-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const at = (p) => path.join(home, p);
  const skill = (name, text = "做法") =>
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n${text}`;
  write(at(".agents/skills"), "shared", skill("shared"));
  fs.mkdirSync(at(".claude/skills"), { recursive: true });
  fs.symlinkSync(at(".agents/skills/shared"), at(".claude/skills/shared"));
  write(at(".claude/skills"), "claude-only", skill("claude-only"));
  write(at(".codex/skills"), "codex-only", skill("codex-only"));
  write(at(".codex/skills"), "copy-of-shared", skill("shared", "另一份"));
  write(at(".codex/skills/.system"), "hidden", skill("hidden"));
  fs.writeFileSync(at(".claude/skills/SKILL.md"), skill("loose"));
  let stored = {};
  const lib = new SkillLibrary({
    dir: at("otter"),
    external: [
      { id: "agents", label: "共享", dir: at(".agents/skills") },
      { id: "claude", label: "Claude Code", dir: at(".claude/skills") },
      { id: "codex", label: "Codex", dir: at(".codex/skills") },
      { id: "none", label: "不存在", dir: at(".nothing/skills") },
    ],
    load: () => stored,
    save: (v) => (stored = v),
  });
  const state = lib.scan();
  assert.deepEqual(
    state.items.map((i) => [i.name, i.source, i.alsoIn, i.active]),
    [
      ["claude-only", "claude", [], true],
      ["codex-only", "codex", [], true],
      ["shared", "agents", ["Claude Code", "Codex"], true],
    ],
  );
  assert.deepEqual(
    state.problems,
    [],
    "Duplicates in tools' folders are not problems",
  );
  assert.deepEqual(
    state.sources.map((s) => [s.id, s.count, s.exists, s.enabled]),
    [
      ["otter", 0, true, true],
      ["agents", 1, true, true],
      ["claude", 2, true, true],
      ["codex", 2, true, true],
      ["none", 0, false, true],
    ],
  );
  lib.setSource("codex", false);
  const names = () =>
    lib.source().list()[0].parameters.properties.name.enum.slice().sort();
  assert.deepEqual(names(), ["claude-only", "shared"]);
  lib.setSource("agents", false);
  assert.deepEqual(
    names(),
    ["claude-only", "shared"],
    "Still reachable through Claude Code",
  );
  lib.setSource("claude", false);
  assert.deepEqual(lib.source().list(), []);
  assert.throws(() => lib.setSource("otter", false), /不能单独开关/);
  assert(
    fs.existsSync(at(".codex/skills/codex-only/SKILL.md")),
    "Nothing is moved or copied",
  );
});

test("many skills still fit in one offer", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otter-many-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = new SkillLibrary({
    dir: path.join(root, "otter"),
    load: () => ({}),
    save: () => {},
  });
  for (let i = 0; i < 80; i++)
    write(
      lib.dir,
      `s${i}`,
      `---\nname: skill-${i}\ndescription: ${"很长的说明".repeat(80)}\n---\nx`,
    );
  lib.scan();
  const [use] = lib.source().list();
  assert.equal(use.parameters.properties.name.enum.length, 80);
  assert(JSON.stringify(use.parameters).length < 11000);
});

test("a long SKILL.md is offered in parts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otter-long-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = new SkillLibrary({
    dir: path.join(root, "otter"),
    load: () => ({}),
    save: () => {},
  });
  const body = "甲".repeat(20000) + "乙".repeat(10000);
  write(lib.dir, "long", `---\nname: long\ndescription: 很长\n---\n${body}`);
  lib.scan();
  const [use, read] = lib.source().list();
  const first = await use.run({ name: "long" });
  assert.match(first, /part 从 2 开始/);
  assert(!first.includes("乙"));
  const second = await read.run({ name: "long", file: "SKILL.md", part: 2 });
  assert.match(second, /第 2\/3 段，下一段 part=3/);
  assert.throws(
    () => read.run({ name: "long", file: "SKILL.md", part: 9 }),
    /没有第 9 段/,
  );
});

test("listing reads only the head of SKILL.md; the body is read when used", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otter-head-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = new SkillLibrary({
    dir: path.join(root, "otter"),
    load: () => ({}),
    save: () => {},
  });
  // Front matter, then 600 KB of body: listing must not need any of it.
  write(
    lib.dir,
    "big",
    "\uFEFF---\nname: big\ndescription: 很大\n---\n" + "正".repeat(200000),
  );
  const longHead =
    "---\nname: long-head\ndescription: |\n" +
    "  一行说明\n".repeat(1500) +
    "---\n做法";
  write(lib.dir, "long-head", longHead);
  const reads = [];
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    reads.push(String(file));
    return original(file, ...rest);
  };
  try {
    lib.scan();
  } finally {
    fs.readFileSync = original;
  }
  assert.deepEqual(
    lib.snapshot().items.map((i) => i.name),
    ["big", "long-head"],
    "A front matter longer than 8 KB is still read",
  );
  assert(
    !reads.some((f) => f.endsWith("SKILL.md")),
    "No whole SKILL.md read to list",
  );
  assert(!("body" in lib.skills[0]), "No body kept in memory");
  const [use] = lib.source().list();
  await assert.rejects(
    async () => use.run({ name: "big" }),
    /太大（上限 512 KB）/,
  );
  fs.writeFileSync(
    path.join(lib.dir, "long-head", "SKILL.md"),
    longHead.replace("做法", "改过的做法"),
  );
  assert.match(
    await use.run({ name: "long-head" }),
    /改过的做法/,
    "Always the current text",
  );
});

test("refresh picks up new, removed and edited skills and stays quiet otherwise", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otter-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const changes = [];
  const lib = new SkillLibrary({
    dir: path.join(root, "otter"),
    external: [{ id: "codex", label: "Codex", dir: path.join(root, "codex") }],
    load: () => ({}),
    save: () => {},
    onChange: (s) => changes.push(s.items.map((i) => i.name)),
  });
  lib.scan();
  assert.equal(lib.refresh(), false);
  assert.equal(changes.length, 1, "Nothing new, nothing said");
  write(
    path.join(root, "codex"),
    "fresh",
    "---\nname: fresh\ndescription: 新装的\n---\nx",
  );
  assert.equal(lib.refresh(), true);
  assert.deepEqual(changes.at(-1), ["fresh"]);
  write(
    path.join(root, "codex"),
    "fresh",
    "---\nname: fresh\ndescription: 改了说明\n---\nx",
  );
  assert.equal(lib.refresh(), true, "An edited description counts");
  assert.equal(lib.snapshot().items[0].description, "改了说明");
  fs.rmSync(path.join(root, "codex", "fresh"), { recursive: true });
  assert.equal(lib.refresh(), true);
  assert.deepEqual(lib.source().list(), []);
});
