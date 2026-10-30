const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Backdrop, sniff } = require("./backdrop.cjs");
const { SettingsRegistry } = require("./settings-registry.cjs");

const ICON =
  "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/FinderIcon.icns";
const sips = (...args) =>
  execFileSync("/usr/bin/sips", args, { stdio: "pipe" });
const dims = (file) => {
  const out = sips("-g", "pixelWidth", "-g", "pixelHeight", file).toString();
  return [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((r) =>
    Number(r.exec(out)[1]),
  );
};

// Real pictures made with sips: a PNG, a HEIC, a JPEG too large to keep as is.
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "otter-backdrop-"));
const png = path.join(fixtures, "海边.png");
const heic = path.join(fixtures, "IMG_0001.HEIC");
const big = path.join(fixtures, "big.jpg");
const gif = path.join(fixtures, "moving.gif");
sips("-s", "format", "png", "-z", "120", "160", ICON, "--out", png);
sips("-s", "format", "heic", png, "--out", heic);
sips("-s", "format", "jpeg", "-z", "3000", "4000", png, "--out", big);
fs.writeFileSync(
  gif,
  Buffer.from(
    "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    "base64",
  ),
);
test.after(() => fs.rmSync(fixtures, { recursive: true, force: true }));

function make(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-backgrounds-"));
  const saved = [];
  const changes = [];
  const backdrop = new Backdrop({
    dir,
    home: fixtures,
    save: (v) => saved.push(v),
    onChange: (v) => changes.push(v),
    ...extra,
  });
  return { dir, backdrop, saved, changes };
}
// Another picture each call: the PNG with bytes after its end.
let variant = 0;
function another() {
  const file = path.join(fixtures, `pic-${++variant}.png`);
  fs.writeFileSync(
    file,
    Buffer.concat([fs.readFileSync(png), Buffer.from(String(variant))]),
  );
  return file;
}

test("sniff knows images by their first bytes, not their names", () => {
  const head = (hex, ascii = "") =>
    Buffer.concat([Buffer.from(hex, "hex"), Buffer.from(ascii, "latin1")]);
  assert.equal(sniff(fs.readFileSync(png)), "png");
  assert.equal(sniff(fs.readFileSync(big)), "jpeg");
  assert.equal(sniff(fs.readFileSync(heic)), "heic");
  assert.equal(sniff(fs.readFileSync(gif)), "gif");
  assert.equal(sniff(head("", "RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(sniff(head("00000020", "ftypavif")), "avif");
  assert.equal(sniff(head("", "MM\0*\0\0")), "tiff");
  assert.equal(sniff(head("", "BM\0\0")), "bmp");
  for (const text of ["hello world", "<svg xmlns=", "%PDF-1.7", ""])
    assert.equal(sniff(Buffer.from(text)), null);
});

test("a PNG is copied as it is, named by its contents, and shown", async () => {
  const { dir, backdrop, saved, changes } = make();
  assert.deepEqual(backdrop.snapshot(), {
    current: null,
    transparency: 40,
    recent: [],
  });
  const snap = await backdrop.add(png);
  const { file } = snap.current;
  assert.match(file, /^[0-9a-f]{16}\.png$/);
  assert.equal(snap.current.name, "海边.png");
  assert.equal(snap.current.url, `otter-backdrop://image/${file}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, file)), fs.readFileSync(png));
  assert.deepEqual(saved.at(-1), {
    current: file,
    transparency: 40,
    recent: [{ file, name: "海边.png" }],
  });
  assert.equal(changes.length, 1);
  assert.deepEqual(fs.readdirSync(dir), [file], "nothing else is left behind");
  // The same picture again is the same entry.
  await backdrop.add(png);
  assert.equal(backdrop.snapshot().recent.length, 1);
});

test("HEIC is converted to JPEG and a huge photo scaled down; GIFs keep moving", async () => {
  const { dir, backdrop } = make();
  const photo = (await backdrop.add(heic)).current;
  assert.match(photo.file, /\.jpg$/);
  assert.equal(photo.name, "IMG_0001.HEIC");
  assert.equal(sniff(fs.readFileSync(path.join(dir, photo.file))), "jpeg");
  const large = (await backdrop.add(big)).current;
  assert.deepEqual(dims(path.join(dir, large.file)), [3200, 2400]);
  const moving = (await backdrop.add(gif)).current;
  assert.match(moving.file, /\.gif$/);
  assert.deepEqual(
    fs.readFileSync(path.join(dir, moving.file)),
    fs.readFileSync(gif),
  );
});

test("missing files, folders, non-images and huge files are refused plainly", async () => {
  const { dir, backdrop, saved } = make();
  const text = path.join(fixtures, "notes.jpg");
  fs.writeFileSync(text, "not a picture");
  const huge = path.join(fixtures, "huge.png");
  fs.writeFileSync(huge, fs.readFileSync(png));
  fs.truncateSync(huge, 41 * 1024 * 1024);
  for (const [source, error] of [
    [path.join(fixtures, "nope.png"), /找不到这张图片/],
    [fixtures, /这不是一张图片/],
    [text, /这不是能用的图片/],
    [huge, /40 MB/],
    ["", /这不是一张图片|找不到/],
  ])
    await assert.rejects(backdrop.add(source), error);
  assert.equal(saved.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("the last six pictures are kept; older copies are deleted", async () => {
  const { dir, backdrop } = make();
  const files = [];
  for (let i = 0; i < 7; i++)
    files.push((await backdrop.add(another())).current.file);
  const snap = backdrop.snapshot();
  assert.deepEqual(
    snap.recent.map((r) => r.file),
    files.slice(1).reverse(),
  );
  assert.equal(snap.current.file, files[6]);
  assert.equal(fs.existsSync(path.join(dir, files[0])), false);
  assert.equal(fs.readdirSync(dir).length, 6);
  // Using an older one puts it first and shows it.
  backdrop.use(files[2]);
  assert.equal(backdrop.snapshot().current.file, files[2]);
  assert.equal(backdrop.snapshot().recent[0].file, files[2]);
  // Clearing keeps the pictures; forgetting deletes one, and the current one
  // goes away with it.
  backdrop.clear();
  assert.equal(backdrop.snapshot().current, null);
  assert.equal(backdrop.snapshot().recent.length, 6);
  backdrop.use(files[3]);
  backdrop.forget(files[3]);
  assert.equal(backdrop.snapshot().current, null);
  assert.equal(fs.existsSync(path.join(dir, files[3])), false);
  assert.throws(() => backdrop.use(files[3]), /已经不在了/);
  assert.throws(() => backdrop.forget(files[0]), /已经不在了/);
});

test("only listed copies are served", async () => {
  const { dir, backdrop } = make();
  const { file } = (await backdrop.add(png)).current;
  assert.equal(backdrop.locate(file), path.join(dir, file));
  assert.equal(backdrop.mime(file), "image/png");
  fs.writeFileSync(path.join(dir, "0123456789abcdef.png"), "x");
  for (const name of [
    "0123456789abcdef.png",
    `../${file}`,
    `${file}/..`,
    "/etc/passwd",
    "desktop.json",
    "",
  ])
    assert.equal(backdrop.locate(name), null, name);
});

test("transparency is a whole percent from 0 to 95", () => {
  const { backdrop, saved } = make();
  backdrop.setTransparency(0);
  backdrop.setTransparency(95);
  assert.equal(backdrop.snapshot().transparency, 95);
  for (const value of [96, -5, 2.5, "40", null, true])
    assert.throws(() => backdrop.setTransparency(value), /0 到 95%/);
  assert.equal(saved.at(-1).transparency, 95);
});

test("saved state comes back; stray files and bad entries are dropped", async () => {
  const first = make();
  const { file } = (await first.backdrop.add(png)).current;
  first.backdrop.setTransparency(70);
  fs.writeFileSync(path.join(first.dir, ".incoming-crashed"), "x");
  fs.writeFileSync(path.join(first.dir, "fedcba9876543210.jpg"), "x");
  const again = new Backdrop({
    dir: first.dir,
    load: () => ({
      ...first.saved.at(-1),
      recent: [
        ...first.saved.at(-1).recent,
        { file: "../../escape.png", name: "x" },
        { file: "aaaaaaaaaaaaaaaa.png", name: "gone" },
      ],
    }),
  });
  assert.deepEqual(again.snapshot(), {
    current: {
      file,
      name: "海边.png",
      url: `otter-backdrop://image/${file}`,
    },
    transparency: 70,
    recent: [{ file, name: "海边.png", url: `otter-backdrop://image/${file}` }],
  });
  assert.deepEqual(fs.readdirSync(first.dir), [file]);
  const odd = new Backdrop({
    dir: first.dir,
    load: () => ({ current: "nope.png", transparency: 400, recent: "x" }),
  });
  assert.deepEqual(odd.snapshot(), {
    current: null,
    transparency: 40,
    recent: [],
  });
});

test("chat reads the stored path, sets a named picture, and puts one back", async () => {
  const { dir, backdrop } = make();
  const reg = new SettingsRegistry([
    {
      id: "backdrop.image",
      label: "背景图",
      type: "text",
      max: 1000,
      empty: true,
      path: true,
      hint: "图片文件的路径",
      check: (v) => backdrop.chatCheck(v),
      format: (v) => backdrop.label(v),
      read: () => backdrop.chatValue(),
      write: (v) => backdrop.chatSet(v),
    },
  ]);
  assert.deepEqual(await reg.rows(), [
    {
      id: "backdrop.image",
      label: "背景图",
      type: "text",
      max: 1000,
      empty: true,
      path: true,
      hint: "图片文件的路径",
      current: "",
    },
  ]);
  assert.equal(reg.format("backdrop.image", ""), "无");
  assert.throws(
    () => reg.validate("backdrop.image", "~/nope.png"),
    /找不到这张图片/,
  );
  assert.equal(reg.validate("backdrop.image", " ~/海边.png "), "~/海边.png");
  assert.equal(reg.format("backdrop.image", "~/海边.png"), "海边.png");
  const stored = await reg.write("backdrop.image", "~/海边.png");
  assert.equal(path.dirname(stored), dir);
  assert.equal(reg.format("backdrop.image", stored), "海边.png");
  // Back to none, then the stored copy again: no new copy is made.
  assert.equal(await reg.write("backdrop.image", ""), "");
  assert.equal(backdrop.snapshot().recent.length, 1);
  reg.validate("backdrop.image", stored);
  assert.equal(await reg.write("backdrop.image", stored), stored);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(stored)]);
});
