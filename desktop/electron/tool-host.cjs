// Runs the tools the chat model asks for. Sources (built-ins, MCP servers,
// skills) each list tools; the host offers them to the model, and when a call
// comes back it checks permission, asks the user on a card if needed, runs the
// tool with a time limit and hands the result back as text.
//
// A tool is { name, label, origin, description, parameters, readOnly, trusted,
// run(args, context) }. Only trusted read-only tools (Otter's own look-ups) run
// without asking; everything else waits for 允许一次 / 这段对话都允许 / 拒绝.
const MAX_RESULT = 16000;

function text(result) {
  const value =
    typeof result === "string" ? result : JSON.stringify(result ?? "", null, 1);
  return value.length > MAX_RESULT
    ? value.slice(0, MAX_RESULT) + "\n…（内容过长，已截断）"
    : value;
}

class ToolHost {
  constructor({
    sources = [],
    onChange = () => {},
    runTimeout = 60000,
    askTimeout = 150000,
  } = {}) {
    Object.assign(this, { sources, onChange, runTimeout, askTimeout });
    this.waiting = new Map();
    this.sessionGrants = new Set();
  }
  addSource(source) {
    this.sources.push(source);
  }
  tools() {
    const seen = new Map();
    for (const source of this.sources)
      for (const tool of source.list())
        if (!seen.has(tool.name)) seen.set(tool.name, tool);
    return [...seen.values()];
  }
  definitions() {
    return this.tools().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || t.label,
        parameters: t.parameters || { type: "object", properties: {} },
      },
    }));
  }
  pending() {
    return [...this.waiting.values()].map(
      ({ resolve, timer, ...rest }) => rest,
    );
  }
  // The user's answer on a card: once, session (this conversation) or deny.
  decide(id, decision) {
    const entry = this.waiting.get(id);
    if (!entry) throw new Error("这个请求已经结束。");
    if (!["once", "session", "deny"].includes(decision))
      throw new Error("无效的选择。");
    entry.resolve(decision);
  }
  // A stopped or finished reply drops any card still waiting for it.
  cancelTurn(turnId) {
    for (const entry of this.waiting.values())
      if (entry.turnId === turnId) entry.resolve("deny");
  }
  forgetSession(sessionId) {
    for (const key of this.sessionGrants)
      if (key.startsWith(sessionId + "\n")) this.sessionGrants.delete(key);
  }
  ask(call, tool) {
    return new Promise((resolve) => {
      const entry = {
        id: call.call_id,
        turnId: call.turn_id,
        sessionId: call.session_id,
        name: tool.name,
        label: tool.label,
        origin: tool.origin,
        arguments: call.arguments || {},
        resolve: (decision) => {
          clearTimeout(entry.timer);
          if (!this.waiting.delete(entry.id)) return;
          this.onChange(this.pending());
          resolve(decision);
        },
      };
      entry.timer = setTimeout(() => entry.resolve("deny"), this.askTimeout);
      this.waiting.set(entry.id, entry);
      this.onChange(this.pending());
    });
  }
  async handle(call) {
    const tool = this.tools().find((t) => t.name === call.name);
    if (!tool)
      return { ok: false, content: "没有这个工具。", label: call.name };
    const grant = `${call.session_id}\n${tool.name}`;
    if (!(tool.readOnly && tool.trusted) && !this.sessionGrants.has(grant)) {
      const decision = await this.ask(call, tool);
      if (decision === "deny")
        return {
          ok: false,
          content:
            "用户没有允许这次调用，请不要再试同样的调用，可以换个方式帮忙。",
          label: tool.label,
        };
      if (decision === "session") this.sessionGrants.add(grant);
    }
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          tool.run(call.arguments || {}, { sessionId: call.session_id }),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("工具运行超时。")),
            this.runTimeout,
          );
        }),
      ]);
      return { ok: true, content: text(result), label: tool.label };
    } catch (error) {
      return {
        ok: false,
        content: `工具出错：${error?.message || String(error)}`.slice(0, 2000),
        label: tool.label,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
module.exports = { ToolHost };
