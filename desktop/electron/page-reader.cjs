const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { BROWSERS, cleanTab } = require("./awareness.cjs");
// Fixed, read-only extraction. Form controls, editable regions and hidden text are omitted.
function extractPage() {
  if (!["http:", "https:"].includes(location.protocol))
    return JSON.stringify({ status: "unsupported" });
  const visibleCache = new WeakMap();
  function visible(element) {
    if (!element) return true;
    if (visibleCache.has(element)) return visibleCache.get(element);
    const style = getComputedStyle(element);
    const yes =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      Number(style.opacity) !== 0 &&
      visible(element.parentElement);
    visibleCache.set(element, yes);
    return yes;
  }
  const root =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.body;
  if (!root) return JSON.stringify({ status: "empty" });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  let size = 0,
    truncated = false,
    visited = 0;
  while (walker.nextNode()) {
    if (++visited > 50000) {
      truncated = true;
      break;
    }
    const node = walker.currentNode,
      parent = node.parentElement;
    if (
      !parent ||
      parent.closest(
        'script,style,noscript,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[aria-hidden="true"],[hidden]',
      )
    )
      continue;
    const style = getComputedStyle(parent);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      !parent.getClientRects().length ||
      !visible(parent)
    )
      continue;
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const available = 20000 - size;
    if (available <= 0) {
      truncated = true;
      break;
    }
    parts.push(text.slice(0, available));
    size += Math.min(text.length, available) + 1;
    if (text.length > available) {
      truncated = true;
      break;
    }
  }
  return JSON.stringify({
    status: "ready",
    title: document.title,
    url: location.href,
    text: parts.join("\n"),
    truncated,
  });
}
function formatPage(result, id) {
  if (
    !result ||
    result.status !== "ready" ||
    typeof result.text !== "string" ||
    !result.text.trim()
  )
    throw new Error(
      "没有读到可见正文。页面可能尚未加载，或使用了 PDF/画布/跨域嵌入。",
    );
  const meta = cleanTab(result, id);
  if (!meta?.url) throw new Error("仅支持普通 HTTP(S) 网页正文。");
  const text = result.text.slice(0, 20000);
  return `网页标题：${meta.title}\n来源：${meta.url}\n浏览器：${BROWSERS[id]}\n读取时间：${new Date().toLocaleString()}\n${result.truncated || result.text.length > 20000 ? "正文较长，以下为前 20000 字符摘录，并非全文。" : "以下为当前页面已加载的可见正文。"}\n\n${text}`;
}
function readPage(id) {
  if (!Object.hasOwn(BROWSERS, id))
    return Promise.reject(new Error("暂不支持这个浏览器。"));
  const source = `(${extractPage.toString()})()`;
  const script = fs.readFileSync(
    path.join(__dirname, "native/page.js"),
    "utf8",
  );
  return new Promise((resolve, reject) =>
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, id, source],
      { timeout: 15000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              "网页正文读取未获允许或暂不可用。请检查 macOS 自动化权限，以及浏览器的“允许来自 Apple 事件的 JavaScript”设置后手动重试。",
            ),
          );
          return;
        }
        try {
          resolve(formatPage(JSON.parse(stdout), id));
        } catch (error) {
          reject(error);
        }
      },
    ),
  );
}
module.exports = { extractPage, formatPage, readPage };
