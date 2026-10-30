// A stand-in remote MCP server for tests, in either transport: streamable
// HTTP at /mcp (a session id from initialize is then required; tools/list
// answers as an event stream) or the older SSE one at /sse. Same two tools as
// fake-mcp-server.cjs. Optional bearer token. Records what it was sent.
const fs = require("node:fs");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const TOOLS = [
  {
    name: "look",
    title: "看笔记",
    description: "列出已记下的笔记",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_note",
    title: "记一条笔记",
    description: "记下一条笔记",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

function answer(message, notesFile) {
  if (message.method === "initialize")
    return {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-http", version: "1" },
    };
  if (message.method === "tools/list") return { tools: TOOLS };
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    if (name === "add_note") {
      if (notesFile) fs.appendFileSync(notesFile, args.text + "\n");
      return { content: [{ type: "text", text: `记下了：${args.text}` }] };
    }
    const notes =
      notesFile && fs.existsSync(notesFile)
        ? fs.readFileSync(notesFile, "utf8")
        : "";
    return { content: [{ type: "text", text: notes || "还没有笔记" }] };
  }
  return null;
}

const body = (req) =>
  new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });

async function startFakeHttpMcp({ transport = "http", token, notesFile } = {}) {
  const seen = [];
  const sessions = new Set();
  let stream = null;
  const server = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      return res.end();
    }
    if (transport === "sse") {
      if (req.method === "GET" && req.url === "/sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages?sid=1\n\n");
        stream = res;
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/messages")) {
        const message = JSON.parse(await body(req));
        seen.push({ method: message.method });
        res.statusCode = 202;
        res.end();
        if (message.id != null && stream)
          stream.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message, notesFile) })}\n\n`,
          );
        return;
      }
      res.statusCode = 404;
      return res.end();
    }
    const session = req.headers["mcp-session-id"];
    if (req.method === "DELETE") {
      sessions.delete(session);
      seen.push({ method: "DELETE", session });
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.statusCode = 404;
      return res.end();
    }
    const message = JSON.parse(await body(req));
    seen.push({
      method: message.method,
      session,
      protocol: req.headers["mcp-protocol-version"],
    });
    if (message.method !== "initialize" && !sessions.has(session)) {
      res.statusCode = 404;
      return res.end();
    }
    if (message.id == null) {
      res.statusCode = 202;
      return res.end();
    }
    const reply = {
      jsonrpc: "2.0",
      id: message.id,
      result: answer(message, notesFile),
    };
    if (message.method === "initialize") {
      const id = randomUUID();
      sessions.add(id);
      res.setHeader("Mcp-Session-Id", id);
    }
    if (message.method === "tools/list") {
      res.setHeader("Content-Type", "text/event-stream");
      return res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/${transport === "sse" ? "sse" : "mcp"}`;
  return {
    url,
    seen,
    close: () => {
      stream?.end();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { startFakeHttpMcp };
