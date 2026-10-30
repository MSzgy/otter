// Reads a public web page for the chat model: fetches it, follows a few
// redirects, and turns the HTML into plain text (title, address, body).
//
// The model chooses the address, and words on a page could try to steer it,
// so this never reaches this Mac or the local network: every address a name
// resolves to is checked at connect time (not before, so a name cannot switch
// to a private address in between), on every redirect. Only http and https,
// GET only, no cookies, a size and time limit.
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");
const zlib = require("node:zlib");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 20000;

// Loopback, private, link-local, carrier-grade NAT, multicast and the like.
function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

function checkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("这不是有效的网址。");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("只能读取 http 或 https 网页。");
  if (url.username || url.password) throw new Error("网址里不能带账号密码。");
  return url;
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  copy: "©",
};
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === "#") {
      const n =
        code[1].toLowerCase() === "x"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : "";
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

// A meta tag's content, whichever order its attributes come in.
function meta(html, name) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:name|property)=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (key?.toLowerCase() === name)
      return decode(/\bcontent=["']([^"']*)["']/i.exec(tag)?.[1] || "").trim();
  }
  return "";
}

// The readable part of an HTML page as plain text.
function htmlText(html) {
  const description = meta(html, "description") || meta(html, "og:description");
  const title = decode(
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").trim(),
  ).replace(/\s+/g, " ");
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|template|iframe|head|title|form)\b[\s\S]*?<\/\1>/gi,
      " ",
    );
  // Prefer the article or main content when the page marks it.
  const main =
    /<article\b[\s\S]*<\/article>/i.exec(body)?.[0] ||
    /<main\b[\s\S]*<\/main>/i.exec(body)?.[0];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 200) body = main;
  else body = body.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const text = decode(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(
        /<\/(p|div|section|article|h[1-6]|tr|blockquote|pre|ul|ol|table)>/gi,
        "\n",
      )
      .replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, description, text };
}

function charsetOf(type, head) {
  const declared =
    /charset=["']?([\w-]+)/i.exec(type)?.[1] ||
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  return (declared || "utf-8").toLowerCase();
}

class WebReader {
  constructor({ allowPrivate = false, timeout = 15000 } = {}) {
    Object.assign(this, { allowPrivate, timeout });
  }
  // Resolves the name and refuses private answers, at connect time.
  lookup() {
    return (hostname, options, callback) => {
      dns.lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error);
        const bad = addresses.find((a) => privateAddress(a.address));
        if (bad && !this.allowPrivate)
          return callback(
            Object.assign(new Error("不能读取本机或局域网里的地址。"), {
              code: "OTTER_PRIVATE",
            }),
          );
        const first = addresses[0];
        if (options?.all) return callback(null, addresses);
        callback(null, first.address, first.family);
      });
    };
  }
  get(url) {
    return new Promise((resolve, reject) => {
      if (!this.allowPrivate && net.isIP(url.hostname.replace(/^\[|\]$/g, "")))
        if (privateAddress(url.hostname.replace(/^\[|\]$/g, "")))
          return reject(new Error("不能读取本机或局域网里的地址。"));
      const client = url.protocol === "https:" ? https : http;
      const request = client.get(
        url,
        {
          lookup: this.lookup(),
          timeout: this.timeout,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh) Otter/0.12 (reading for its user)",
            Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
        },
        (response) => resolve(response),
      );
      request.on("timeout", () =>
        request.destroy(new Error("网页太久没有回应。")),
      );
      request.on("error", (error) =>
        reject(
          error.code === "OTTER_PRIVATE"
            ? error
            : error.code === "ENOTFOUND"
              ? new Error("找不到这个网站。")
              : new Error(`读不到这个网页：${error.message}`),
        ),
      );
    });
  }
  async body(response) {
    const encoding = (response.headers["content-encoding"] || "").toLowerCase();
    const stream =
      encoding === "gzip"
        ? response.pipe(zlib.createGunzip())
        : encoding === "deflate"
          ? response.pipe(zlib.createInflate())
          : encoding === "br"
            ? response.pipe(zlib.createBrotliDecompress())
            : response;
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        response.destroy();
        break;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async read(address) {
    let url = checkUrl(address);
    for (let hop = 0; hop <= 5; hop++) {
      const response = await this.get(url);
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const next = response.headers.location;
        if (!next) throw new Error("网页要求跳转，但没有给出地址。");
        url = checkUrl(new URL(next, url).href);
        continue;
      }
      if (status >= 400) {
        response.resume();
        throw new Error(
          status === 401 || status === 403
            ? `这个网页需要登录或不让读取（HTTP ${status}）。`
            : status === 404
              ? "网页不存在（HTTP 404）。"
              : `网站返回 HTTP ${status}。`,
        );
      }
      const type = String(response.headers["content-type"] || "");
      if (!/text\/|json|xml|markdown/i.test(type)) {
        response.resume();
        throw new Error("这个地址不是网页或文字（可能是图片、视频或文件）。");
      }
      const bytes = await this.body(response);
      let charset = charsetOf(type, bytes.subarray(0, 2048).toString("latin1"));
      let raw;
      try {
        raw = new TextDecoder(charset).decode(bytes);
      } catch {
        raw = new TextDecoder("utf-8").decode(bytes);
      }
      const {
        title,
        description = "",
        text,
      } = /html/i.test(type) ? htmlText(raw) : { title: "", text: raw.trim() };
      const clipped =
        text.length > MAX_TEXT
          ? text.slice(0, MAX_TEXT) + "\n…（正文过长，只读了前面一部分）"
          : text;
      // Pages drawn by scripts have little text before a browser runs them.
      const thin =
        text.length < 200
          ? "\n\n（这个网页的文字很少，内容可能要在浏览器里运行脚本才显示。可以请用户在浏览器打开它，再用“附带当前场景”把看到的内容发来。）"
          : "";
      return [
        ...(title ? [`标题：${title}`] : []),
        ...(description ? [`简介：${description}`] : []),
        `网址：${url.href}`,
        "",
        (clipped || "（没有读到正文）") + thin,
      ].join("\n");
    }
    throw new Error("网页跳转次数太多。");
  }
}

module.exports = { WebReader, htmlText, privateAddress, checkUrl };
