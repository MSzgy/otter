// Skills: folders with a SKILL.md, in the same shape as Claude's Agent
// Skills (front matter with name and description, then instructions). They
// live in <userData>/skills. The chat model sees each skill's name and
// description and loads one with use_skill when it needs it; it can read the
// skill's other text files with read_skill_file. Nothing in a skill is run.
const fs = require("node:fs");
const path = require("node:path");

const MAX_SKILL = 256 * 1024;
const MAX_FILE = 512 * 1024;
// What one tool answer carries; longer text is read in parts.
const PART = 14000;
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
  if (stat.size > MAX_SKILL) throw new Error("SKILL.md 太大（上限 256 KB）");
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

// Where skills come from, in order of precedence when names clash.
// builtin ships with the app; otter is the user's own folder; the rest are
// other tools' folders, read in place (never copied or changed) and each with
// its own switch.
class SkillLibrary {
  constructor({
    dir,
    builtin = null,
    external = [],
    load,
    save,
    onChange = () => {},
  }) {
    Object.assign(this, { dir, builtin, external, load, save, onChange });
    this.skills = [];
    this.problems = [];
    this.counts = {};
  }
  settings() {
    const value = this.load() || {};
    return {
      disabled: Array.isArray(value.disabled) ? value.disabled : [],
      sourcesOff: Array.isArray(value.sourcesOff) ? value.sourcesOff : [],
    };
  }
  disabled() {
    return this.settings().disabled;
  }
  sources() {
    return [
      ...(this.builtin
        ? [{ id: "builtin", label: "自带", dir: this.builtin, fixed: true }]
        : []),
      { id: "otter", label: "Otter", dir: this.dir, fixed: true },
      ...this.external,
    ];
  }
  scan() {
    fs.mkdirSync(this.dir, { recursive: true });
    const skills = [],
      problems = [],
      counts = {};
    for (const source of this.sources()) {
      counts[source.id] = 0;
      if (!fs.existsSync(source.dir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(source.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        // Skill folders may be symbolic links (other tools share them).
        if (entry.name.startsWith(".")) continue;
        const folder = path.join(source.dir, entry.name);
        let real;
        try {
          if (!fs.statSync(folder).isDirectory()) continue;
          if (!fs.existsSync(path.join(folder, "SKILL.md"))) continue;
          real = fs.realpathSync(folder);
        } catch {
          continue;
        }
        counts[source.id]++;
        try {
          const skill = { ...readSkill(folder), real, source: source.id };
          const twin = skills.find(
            (s) => s.real === real || s.name === skill.name,
          );
          if (twin && !source.fixed) {
            // The same skill seen again from another tool's folder.
            if (!twin.alsoIn.includes(source.id)) twin.alsoIn.push(source.id);
            continue;
          }
          if (twin)
            throw new Error(
              `和${twin.source === "builtin" ? "自带的" : "另一个"} skill 重名：${skill.name}`,
            );
          skills.push({ ...skill, alsoIn: [] });
        } catch (error) {
          problems.push({
            source: source.id,
            folder: entry.name,
            message: error.message,
          });
        }
      }
    }
    this.skills = skills.sort((a, b) => a.name.localeCompare(b.name));
    this.problems = problems;
    this.counts = counts;
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  // A skill is offered when it is switched on and at least one folder it
  // was found in is switched on.
  active(skill, settings = this.settings()) {
    return (
      !settings.disabled.includes(skill.name) &&
      [skill.source, ...skill.alsoIn].some(
        (id) => !settings.sourcesOff.includes(id),
      )
    );
  }
  snapshot() {
    const settings = this.settings();
    const label = (id) => this.sources().find((s) => s.id === id)?.label || id;
    return {
      dir: this.dir,
      sources: this.sources().map(({ id, label, dir, fixed }) => ({
        id,
        label,
        dir,
        fixed: !!fixed,
        exists: fs.existsSync(dir),
        enabled: !settings.sourcesOff.includes(id),
        count: this.counts[id] || 0,
      })),
      items: this.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        folder: path.basename(skill.folder),
        source: skill.source,
        alsoIn: skill.alsoIn.map(label),
        builtin: skill.source === "builtin",
        enabled: !settings.disabled.includes(skill.name),
        active: this.active(skill, settings),
      })),
      problems: this.problems,
    };
  }
  setEnabled(name, enabled) {
    if (!this.skills.some((s) => s.name === name))
      throw new Error("没有这个 skill。");
    if (typeof enabled !== "boolean") throw new Error("设置无效。");
    const settings = this.settings();
    const rest = settings.disabled.filter((n) => n !== name);
    this.save({ ...settings, disabled: enabled ? rest : [...rest, name] });
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  setSource(id, enabled) {
    const source = this.sources().find((s) => s.id === id);
    if (!source || source.fixed) throw new Error("这个文件夹不能单独开关。");
    if (typeof enabled !== "boolean") throw new Error("设置无效。");
    const settings = this.settings();
    const rest = settings.sourcesOff.filter((n) => n !== id);
    this.save({ ...settings, sourcesOff: enabled ? rest : [...rest, id] });
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  // Copies a chosen folder (with its SKILL.md) into the user's folder.
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
    const settings = this.settings();
    return this.skills.filter((s) => this.active(s, settings));
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
        // Every skill gets a line; with many, each description is shorter,
        // so the whole offer stays within what the backend accepts.
        const each = Math.max(
          60,
          Math.min(300, Math.floor(7000 / skills.length) - 30),
        );
        const catalogue = skills
          .map((s) => `${s.name}：${s.description.slice(0, each)}`)
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
              const body = skill.body.trim();
              return [
                `# Skill：${skill.name}`,
                body.length > PART
                  ? `${body.slice(0, PART)}\n\n（这个 SKILL.md 很长，这里是开头。后面的内容用 read_skill_file 读 SKILL.md，part 从 2 开始。）`
                  : body,
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
                part: {
                  type: "integer",
                  description: "长文件分段读，从 1 开始",
                },
              },
              required: ["name", "file"],
            },
            run: ({ name, file, part = 1 }) => {
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
                throw new Error("文件太大（上限 512 KB）。");
              const text = fs.readFileSync(full, "utf8");
              if (text.includes("\u0000")) throw new Error("这不是文字文件。");
              const parts = Math.max(1, Math.ceil(text.length / PART));
              const n = Number.parseInt(part, 10) || 1;
              if (n < 1 || n > parts)
                throw new Error(`没有第 ${n} 段，一共 ${parts} 段。`);
              const chunk = text.slice((n - 1) * PART, n * PART);
              return parts > 1
                ? `${chunk}\n\n（第 ${n}/${parts} 段${n < parts ? `，下一段 part=${n + 1}` : ""}）`
                : chunk;
            },
          },
        ];
      },
    };
  }
}
module.exports = { SkillLibrary, frontMatter };
