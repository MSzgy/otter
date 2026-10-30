// Skills: folders with a SKILL.md, in the same shape as Claude's Agent
// Skills (front matter with name and description, then instructions). They
// live in <userData>/skills. The chat model sees each skill's name and
// description and loads one with use_skill when it needs it; it can read the
// skill's other text files with read_skill_file. Nothing in a skill is run.
const fs = require("node:fs");
const path = require("node:path");

const MAX_SKILL = 60000;
const MAX_FILE = 50000;
const MAX_IMPORT = 5 * 1024 * 1024;

// The small part of YAML front matter skills use: `key: value`, quoted
// values, and `key: |` or `key: >` blocks.
function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (value === "|" || value === ">") {
      const block = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]))
        block.push(lines[++i].trim());
      value = block.join(m[2].trim() === "|" ? "\n" : " ").trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[m[1]] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

function readSkill(folder) {
  const file = path.join(folder, "SKILL.md");
  const stat = fs.statSync(file);
  if (stat.size > MAX_SKILL) throw new Error("SKILL.md 太大（上限 60 KB）");
  const { meta, body } = frontMatter(fs.readFileSync(file, "utf8"));
  const name = String(meta.name || "").trim();
  const description = String(meta.description || "").trim();
  if (!name || !description)
    throw new Error("SKILL.md 缺少 name 或 description");
  if (!/^[\w一-鿿][\w一-鿿 .-]{0,63}$/.test(name))
    throw new Error("name 只能用字母、数字、汉字、空格、点和横线，64 字以内");
  return { name, description: description.slice(0, 600), body, folder };
}

// Text files a skill may show the model, relative to its folder.
function listFiles(folder, base = folder, found = []) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || found.length >= 100) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) listFiles(full, base, found);
    else if (entry.isFile() && entry.name !== "SKILL.md")
      found.push(path.relative(base, full));
  }
  return found;
}

class SkillLibrary {
  // dir is the user's folder; builtin is the folder of skills shipped with
  // the app (read-only, can be switched off like any other).
  constructor({ dir, builtin = null, load, save, onChange = () => {} }) {
    Object.assign(this, { dir, builtin, load, save, onChange });
    this.skills = [];
    this.problems = [];
  }
  disabled() {
    const value = this.load() || {};
    return Array.isArray(value.disabled) ? value.disabled : [];
  }
  scan() {
    fs.mkdirSync(this.dir, { recursive: true });
    const skills = [],
      problems = [];
    const roots = [
      ...(this.builtin && fs.existsSync(this.builtin)
        ? [{ root: this.builtin, builtin: true }]
        : []),
      { root: this.dir, builtin: false },
    ];
    for (const { root, builtin } of roots)
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const folder = path.join(root, entry.name);
        if (!fs.existsSync(path.join(folder, "SKILL.md"))) continue;
        try {
          const skill = { ...readSkill(folder), builtin };
          const twin = skills.find((s) => s.name === skill.name);
          if (twin)
            throw new Error(
              `和${twin.builtin ? "自带的" : "另一个"} skill 重名：${skill.name}`,
            );
          skills.push(skill);
        } catch (error) {
          problems.push({ folder: entry.name, message: error.message });
        }
      }
    this.skills = skills.sort((a, b) => a.name.localeCompare(b.name));
    this.problems = problems;
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  snapshot() {
    const off = this.disabled();
    return {
      dir: this.dir,
      items: this.skills.map(({ name, description, folder, builtin }) => ({
        name,
        description,
        folder: path.basename(folder),
        builtin,
        enabled: !off.includes(name),
      })),
      problems: this.problems,
    };
  }
  setEnabled(name, enabled) {
    if (!this.skills.some((s) => s.name === name))
      throw new Error("没有这个 skill。");
    if (typeof enabled !== "boolean") throw new Error("设置无效。");
    const rest = this.disabled().filter((n) => n !== name);
    this.save({ disabled: enabled ? rest : [...rest, name] });
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  // Copies a chosen folder (with its SKILL.md) into the library.
  import(source) {
    const skill = readSkill(source);
    let size = 0;
    for (const file of listFiles(source)) {
      size += fs.statSync(path.join(source, file)).size;
      if (size > MAX_IMPORT)
        throw new Error("这个 skill 文件夹太大（上限 5 MB）。");
    }
    const target = path.join(this.dir, path.basename(source));
    if (fs.existsSync(target))
      throw new Error(`已经有同名文件夹：${path.basename(source)}`);
    if (this.skills.some((s) => s.name === skill.name))
      throw new Error(`已经有叫“${skill.name}”的 skill。`);
    fs.cpSync(source, target, {
      recursive: true,
      filter: (src) => !path.basename(src).startsWith("."),
    });
    return this.scan();
  }
  enabledSkills() {
    const off = this.disabled();
    return this.skills.filter((s) => !off.includes(s.name));
  }
  find(name) {
    const skill = this.enabledSkills().find((s) => s.name === name);
    if (!skill) throw new Error(`没有可用的 skill：${name}`);
    return skill;
  }
  // A tool-host source: use_skill and read_skill_file, while any skill is on.
  source() {
    return {
      list: () => {
        const skills = this.enabledSkills();
        if (!skills.length) return [];
        const catalogue = skills
          .map((s) => `${s.name}：${s.description.slice(0, 300)}`)
          .join("\n")
          .slice(0, 8000);
        const names = skills.map((s) => s.name);
        return [
          {
            name: "use_skill",
            label: "读 skill",
            origin: "Skill",
            readOnly: true,
            trusted: true,
            description:
              "读取一个 skill 的完整做法。用户的要求和某个 skill 的说明对得上时，先调用它，再照着做。",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  enum: names,
                  description: `可用的 skill：\n${catalogue}`,
                },
              },
              required: ["name"],
            },
            run: ({ name }) => {
              const skill = this.find(name);
              const files = listFiles(skill.folder);
              return [
                `# Skill：${skill.name}`,
                skill.body.trim(),
                files.length
                  ? `\n这个 skill 附带的文件（可用 read_skill_file 读取文字内容；脚本不会运行）：\n${files.map((f) => "- " + f).join("\n")}`
                  : "",
              ].join("\n\n");
            },
          },
          {
            name: "read_skill_file",
            label: "读 skill 文件",
            origin: "Skill",
            readOnly: true,
            trusted: true,
            description:
              "读取某个 skill 文件夹里的一个文字文件（use_skill 会列出有哪些）。",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string", enum: names },
                file: {
                  type: "string",
                  description: "相对 skill 文件夹的路径",
                },
              },
              required: ["name", "file"],
            },
            run: ({ name, file }) => {
              const skill = this.find(name);
              if (typeof file !== "string") throw new Error("缺少文件路径。");
              const full = path.resolve(skill.folder, file);
              const inside = path.relative(
                fs.realpathSync(skill.folder),
                fs.realpathSync(full),
              );
              if (inside.startsWith("..") || path.isAbsolute(inside))
                throw new Error("只能读这个 skill 文件夹里的文件。");
              const stat = fs.statSync(full);
              if (!stat.isFile()) throw new Error("这不是文件。");
              if (stat.size > MAX_FILE)
                throw new Error("文件太大（上限 50 KB）。");
              const text = fs.readFileSync(full, "utf8");
              if (text.includes("\u0000")) throw new Error("这不是文字文件。");
              return text;
            },
          },
        ];
      },
    };
  }
}
module.exports = { SkillLibrary, frontMatter };
