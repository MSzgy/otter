// A stand-in MCP server for tests: stdio, two tools. `look` is marked
// read-only; `add_note` writes a line to $NOTES_FILE, so a test can tell
// whether a call really ran. Logs a non-JSON line first, as some servers do.
const fs = require("node:fs");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
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
process.stdout.write("fake mcp server starting\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake", version: "1" },
      },
    });
  if (message.method === "tools/list") {
    // Two pages, to exercise pagination.
    const second = message.params?.cursor === "2";
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: second
        ? { tools: [TOOLS[1]] }
        : { tools: [TOOLS[0]], nextCursor: "2" },
    });
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    const file = process.env.NOTES_FILE;
    if (name === "add_note") {
      if (file) fs.appendFileSync(file, args.text + "\n");
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `记下了：${args.text}` }] },
      });
    }
    if (name === "look") {
      const notes =
        file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: notes || "还没有笔记" }] },
      });
    }
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [{ type: "text", text: "没有这个工具" }],
      },
    });
  }
  if (message.id != null)
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "unknown" },
    });
});
