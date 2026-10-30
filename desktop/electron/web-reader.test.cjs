const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const {
  WebReader,
  htmlText,
  privateAddress,
  checkUrl,
} = require("./web-reader.cjs");

test("local, private and odd addresses count as private; public ones do not", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.8",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:192.168.0.1",
  ])
    assert.equal(privateAddress(a), true, a);
  for (const a of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"])
    assert.equal(privateAddress(a), false, a);
  assert.throws(() => checkUrl("file:///etc/passwd"), /只能读取 http/);
  assert.throws(() => checkUrl("https://u:p@a.com"), /账号密码/);
  assert.throws(() => checkUrl("nope"), /有效的网址/);
});

test("HTML becomes readable text: title, article first, no scripts", () => {
  const { title, description, text } =
    htmlText(`<html><head><title>小 &amp; 水獭</title>
    <meta content="一个 &quot;测试&quot; 页" name="description">
    <script>alert(1)</script><style>p{}</style></head><body>
    <nav>菜单 菜单</nav>
    <article><h1>标题一</h1><p>第一段，${"字".repeat(220)}</p><ul><li>甲</li><li>乙</li></ul>
    <p>a&nbsp;b &#x4e2d; &#25991;</p></article><footer>版权</footer></body></html>`);
  assert.equal(title, "小 & 水獭");
  assert.equal(description, '一个 "测试" 页');
  assert.match(text, /^标题一\n第一段/);
  assert.match(text, /• 甲\n• 乙/);
  assert.match(text, /a b 中 文/);
  assert(!/alert|菜单|版权|p\{\}/.test(text));
});

async function server(t, routes) {
  const s = http.createServer((req, res) => routes(req, res));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  return `http://127.0.0.1:${s.address().port}`;
}

test("reads a page through redirects, gzip and a declared charset", async (t) => {
  const base = await server(t, (req, res) => {
    if (req.url === "/old") {
      res.writeHead(301, { Location: "/page" });
      return res.end();
    }
    if (req.url === "/page") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Encoding": "gzip",
      });
      return res.end(zlib.gzipSync("<title>测试页</title><p>你好，水獭</p>"));
    }
    if (req.url === "/gbk") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=gbk" });
      return res.end(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])); // 你好
    }
    if (req.url === "/image") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end("x");
    }
    res.writeHead(404);
    res.end();
  });
  const reader = new WebReader({ allowPrivate: true });
  const page = await reader.read(base + "/old");
  assert(page.startsWith(`标题：测试页\n网址：${base}/page\n\n你好，水獭`));
  assert.match(page, /文字很少.*附带当前场景/, "A thin page says so");
  assert.match(await reader.read(base + "/gbk"), /\n\n你好\n/);
  await assert.rejects(reader.read(base + "/image"), /不是网页或文字/);
  await assert.rejects(reader.read(base + "/missing"), /HTTP 404/);
});

test("this Mac and the local network are refused, by address or by name", async (t) => {
  const base = await server(t, (req, res) => res.end("secret"));
  const reader = new WebReader();
  await assert.rejects(reader.read(base), /本机或局域网/);
  await assert.rejects(
    reader.read(base.replace("127.0.0.1", "localhost")),
    /本机或局域网/,
  );
  await assert.rejects(reader.read("http://[::1]:1/"), /本机或局域网/);
});
