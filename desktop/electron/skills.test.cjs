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
      enabled: true,
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
