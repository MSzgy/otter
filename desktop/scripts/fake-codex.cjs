#!/usr/bin/env node
// A stand-in for the Codex CLI in tests: `--version`, `login status` and
// `exec --json … -` printing events shaped like codex-cli 0.166's. The prompt
// (read from stdin) steers it: "慢慢做" keeps going until stopped, "做不完"
// fails; anything else runs one command, writes otter-agent.txt when the
// sandbox allows writing, and answers. FAKE_CODEX_LOG records each call.
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG)
  fs.appendFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({ args, cwd: process.cwd() }) + "\n",
  );
if (args[0] === "--version") {
  console.log("codex-cli 0.166.0-fake");
  process.exit(0);
}
if (args[0] === "login") {
  if (process.env.FAKE_CODEX_LOGGED_OUT) {
    console.error("Not logged in");
    process.exit(1);
  }
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] !== "exec") process.exit(2);
const option = (name) => args[args.indexOf(name) + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", async () => {
  if (process.env.FAKE_CODEX_LOG)
    fs.appendFileSync(
      process.env.FAKE_CODEX_LOG,
      JSON.stringify({ prompt }) + "\n",
    );
  console.error("2026-10-30T10:42:41Z ERROR rmcp::transport::worker: noise");
  emit({ type: "thread.started", thread_id: "fake-thread-1" });
  emit({
    type: "item.completed",
    item: { id: "item_0", type: "error", message: "a config warning" },
  });
  emit({ type: "turn.started" });
  const command = {
    id: "item_1",
    type: "command_execution",
    command: "/bin/zsh -lc 'ls'",
  };
  emit({ type: "item.started", item: { ...command, status: "in_progress" } });
  emit({
    type: "item.completed",
    item: { ...command, status: "completed", exit_code: 0 },
  });
  if (prompt.includes("慢慢做")) {
    for (let i = 0; ; i++) {
      emit({
        type: "item.started",
        item: {
          id: `slow_${i}`,
          type: "command_execution",
          command: `step ${i}`,
        },
      });
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (prompt.includes("做不完")) {
    emit({ type: "turn.failed", error: { message: "模型额度用完了" } });
    process.exit(1);
  }
  const changes = [];
  if (option("--sandbox") === "workspace-write") {
    const file = path.join(option("--cd"), "otter-agent.txt");
    fs.writeFileSync(file, prompt);
    changes.push({ path: file, kind: "add" });
    emit({
      type: "item.completed",
      item: { id: "item_2", type: "file_change", changes, status: "completed" },
    });
  }
  const text = `做好了。${changes.length ? "写了 otter-agent.txt。" : "只看了文件，没有改动。"}`;
  emit({
    type: "item.completed",
    item: { id: "item_3", type: "agent_message", text },
  });
  fs.writeFileSync(option("--output-last-message"), text + "\n");
  emit({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
  });
});
