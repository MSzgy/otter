import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ino": "text/plain; charset=utf-8",
};
const allowed = /^(?:index\.html|style\.css|app\.mjs|README\.md|src\/[\w-]+\.mjs|docs\/[\w-]+\.md|firmware\/serial_probe\/serial_probe\.ino)$/;

export function createServer() {
  return http.createServer(async (request, response) => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end();
      return;
    }
    let name;
    try {
      name = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "index.html";
    } catch {
      response.writeHead(400, headers).end("Invalid URL");
      return;
    }
    if (!allowed.test(name)) {
      response.writeHead(404, headers).end("Not found");
      return;
    }
    try {
      const data = await readFile(path.join(root, name));
      response.writeHead(200, { ...headers, "Content-Type": contentTypes[path.extname(name)] || "text/plain" });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch {
      response.writeHead(404, headers).end("Not found");
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.OTTER_LAB_PORT || 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OTTER_LAB_PORT 必须是有效端口");
  const server = createServer();
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用。可以设置 OTTER_LAB_PORT=4179 后重新运行。`
      : error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Otter 硬件预演台：http://127.0.0.1:${port}\n仅本机可访问；按 Ctrl+C 停止。`));
}
