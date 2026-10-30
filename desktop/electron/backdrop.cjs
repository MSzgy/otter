// The panel's background picture. A picked image is copied into Otter's own
// folder (moving or deleting the original does not break it); HEIC, TIFF and
// BMP are converted and very large images scaled down with macOS's sips. The
// page reads the copies through the otter-backdrop: scheme, which serves only
// the files listed here. The last few pictures are kept so one can switch back.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");

const SCHEME = "otter-backdrop";
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_SIDE = 3200;
const KEEP = 6;
const DEFAULT_TRANSPARENCY = 40;
const MAX_TRANSPARENCY = 95;
const FILE = /^[0-9a-f]{16}\.(png|jpg|gif|webp|avif)$/;
// Formats Chromium draws as they are; the rest go through sips first.
const WEB = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp", avif: "avif" };
const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

// What kind of image the first bytes say this is, or null.
function sniff(head) {
  const ascii = (from, to) => head.subarray(from, to).toString("latin1");
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return "png";
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  )
    return "jpeg";
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand))
      return "heic";
  }
  if (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*") return "tiff";
  if (ascii(0, 2) === "BM") return "bmp";
  return null;
}

const home = (file, dir) =>
  file.startsWith("~/") ? path.join(dir, file.slice(2)) : file;

function run(command, args) {
  return new Promise((resolve, reject) =>
    execFile(command, args, { timeout: 60000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
}

class Backdrop {
  constructor({
    dir,
    load = () => null,
    save = () => {},
    onChange = () => {},
    home: homeDir = os.homedir(),
    sips = "/usr/bin/sips",
  }) {
    this.dir = dir;
    this.save = save;
    this.onChange = onChange;
    this.homeDir = homeDir;
    this.sips = sips;
    const saved = load() || {};
    const recent = (Array.isArray(saved.recent) ? saved.recent : []).filter(
      (r) =>
        r &&
        FILE.test(r.file) &&
        typeof r.name === "string" &&
        fs.existsSync(path.join(dir, r.file)),
    );
    this.state = {
      current: recent.some((r) => r.file === saved.current)
        ? saved.current
        : null,
      transparency:
        Number.isInteger(saved.transparency) &&
        saved.transparency >= 0 &&
        saved.transparency <= MAX_TRANSPARENCY
          ? saved.transparency
          : DEFAULT_TRANSPARENCY,
      recent: recent.slice(0, KEEP),
    };
    // Copies nothing points at any more (an interrupted import, say) go.
    const kept = new Set(this.state.recent.map((r) => r.file));
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      if (!kept.has(name))
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          // A folder someone put there is left alone.
        }
  }
  entry(r) {
    return { ...r, url: `${SCHEME}://image/${r.file}` };
  }
  snapshot() {
    const current = this.state.recent.find(
      (r) => r.file === this.state.current,
    );
    return {
      current: current ? this.entry(current) : null,
      transparency: this.state.transparency,
      recent: this.state.recent.map((r) => this.entry(r)),
    };
  }
  commit() {
    this.save(structuredClone(this.state));
    this.onChange(this.snapshot());
    return this.snapshot();
  }
  // The stored copy a file name stands for, or null; the scheme serves only these.
  locate(file) {
    if (!FILE.test(file) || !this.state.recent.some((r) => r.file === file))
      return null;
    return path.join(this.dir, file);
  }
  mime(file) {
    return MIME[path.extname(file).slice(1)];
  }
  // A stored copy named by its full path (what chat reads back), or null.
  stored(value) {
    const file = path.resolve(value);
    return path.dirname(file) === path.resolve(this.dir) &&
      this.locate(path.basename(file))
      ? path.basename(file)
      : null;
  }
  // Checks a picture before anything is copied: it exists, is not too large,
  // and its first bytes say it is an image. Plain Chinese errors.
  inspect(source) {
    const file = path.resolve(home(String(source || "").trim(), this.homeDir));
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`找不到这张图片：${source}`);
    }
    if (!stat.isFile()) throw new Error(`这不是一张图片：${source}`);
    if (stat.size > MAX_BYTES)
      throw new Error("图片太大了，请选 40 MB 以内的。");
    const head = Buffer.alloc(32);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, head, 0, 32, 0);
    } finally {
      fs.closeSync(fd);
    }
    const kind = sniff(head);
    if (!kind)
      throw new Error(
        "这不是能用的图片。支持 JPEG、PNG、HEIC、WebP、GIF、AVIF、TIFF 和 BMP。",
      );
    return { file, kind };
  }
  async size(file) {
    try {
      const out = await run(this.sips, [
        "-g",
        "pixelWidth",
        "-g",
        "pixelHeight",
        file,
      ]);
      const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
      return width && height ? { width, height } : null;
    } catch {
      return null;
    }
  }
  // Copies (or converts) a picture into the folder and shows it.
  async add(source) {
    const { file, kind } = this.inspect(source);
    fs.mkdirSync(this.dir, { recursive: true });
    const size = kind === "gif" ? null : await this.size(file);
    const large = size && Math.max(size.width, size.height) > MAX_SIDE;
    let ext = WEB[kind];
    const tmp = path.join(this.dir, `.incoming-${randomUUID()}`);
    try {
      // GIFs stay as they are so they still move.
      if (ext && (kind === "gif" || !large)) fs.copyFileSync(file, tmp);
      else {
        if (!size) throw new Error("读不出这张图片，换一张试试。");
        ext = kind === "png" ? "png" : "jpg";
        await run(this.sips, [
          "-s",
          "format",
          ext === "png" ? "png" : "jpeg",
          ...(ext === "jpg" ? ["-s", "formatOptions", "88"] : []),
          ...(large ? ["-Z", String(MAX_SIDE)] : []),
          file,
          "--out",
          tmp,
        ]).catch(() => {
          throw new Error("这张图片转换失败，换一张试试。");
        });
      }
      const hash = createHash("sha256")
        .update(fs.readFileSync(tmp))
        .digest("hex")
        .slice(0, 16);
      const name = `${hash}.${ext}`;
      fs.renameSync(tmp, path.join(this.dir, name));
      this.remember(name, path.basename(file).slice(0, 80));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return this.commit();
  }
  // Puts a stored picture first and shows it; drops (and deletes) the oldest.
  remember(file, name) {
    const old = this.state.recent.find((r) => r.file === file);
    this.state.recent = [
      { file, name: name || old?.name || file },
      ...this.state.recent.filter((r) => r.file !== file),
    ];
    for (const r of this.state.recent.splice(KEEP))
      fs.rmSync(path.join(this.dir, r.file), { force: true });
    this.state.current = file;
  }
  use(file) {
    if (!this.locate(file)) throw new Error("这张背景图已经不在了。");
    this.remember(file);
    return this.commit();
  }
  clear() {
    this.state.current = null;
    return this.commit();
  }
  forget(file) {
    if (!this.locate(file)) throw new Error("这张背景图已经不在了。");
    fs.rmSync(path.join(this.dir, file), { force: true });
    this.state.recent = this.state.recent.filter((r) => r.file !== file);
    if (this.state.current === file) this.state.current = null;
    return this.commit();
  }
  setTransparency(value) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_TRANSPARENCY)
      throw new Error(`透明度要在 0 到 ${MAX_TRANSPARENCY}% 之间。`);
    this.state.transparency = value;
    return this.commit();
  }
  // Chat reads the picture as its stored path ("" for none) and may set "",
  // a stored path (undo puts one back) or a picture the user named.
  chatValue() {
    return this.state.current ? path.join(this.dir, this.state.current) : "";
  }
  chatCheck(value) {
    if (value && !this.stored(value)) this.inspect(value);
  }
  async chatSet(value) {
    if (!value) return this.clear();
    const file = this.stored(value);
    return file ? this.use(file) : this.add(value);
  }
  label(value) {
    if (!value) return "无";
    const file = this.stored(value);
    return file
      ? this.state.recent.find((r) => r.file === file).name
      : path.basename(value);
  }
}
module.exports = { Backdrop, sniff, SCHEME, MAX_TRANSPARENCY };
