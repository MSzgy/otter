// Drives AI handoff end to end with a real `otter mcp` process acting as the
// AI tool, started from the exact config the app tells users to paste.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { go } = require("./smoke-nav.cjs");
const { spawn } = require("node:child_process");

function mcpClient({ command, args, env = {} }) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiters = new Map();
  let buffer = "",
    sequence = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++sequence;
      waiters.set(id, resolve);
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const call = async (name, args) =>
    (await request("tools/call", { name, arguments: args })).result;
  return { request, call, close: () => child.kill() };
}

async function verifyHandoff({ panel, pet, userData, output }) {
  const open = () => go(panel, "AI 交接");
  const getProject = async (name) => {
    const list = await panel.evaluate(() => window.otter.call("projects.list"));
    const project = list.find((p) => p.name === name && !p.archived);
    return panel.evaluate(
      (id) => window.otter.call("projects.get", { project_id: id }),
      project.id,
    );
  };
  await open();
  await panel.getByRole("heading", { name: "AI 交接", exact: true }).waitFor();
  // The client snippets sit in a collapsed "接入 AI 工具".
  await panel.locator("details.handoff-clients").evaluate((d) => {
    d.open = true;
  });
  const config = JSON.parse(
    await panel.locator(".handoff-setup pre").nth(2).innerText(),
  ).mcpServers.otter;
  assert.equal(
    config.env?.OTTER_HANDOFF_SOCKET,
    path.join(userData, "handoff.sock"),
  );
  const client = mcpClient(config);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "smoke-agent", version: "1" },
      capabilities: {},
    });
    assert.equal(init.result.serverInfo.name, "otter");
    const tools = (await client.request("tools/list")).result.tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ["get_project_context", "propose_progress"],
    );
    const off = await client.call("get_project_context", {});
    assert(off.isError && off.content[0].text.includes("没有运行"));

    await panel
      .getByRole("checkbox", { name: "允许 AI 工具连接 Otter", exact: true })
      .click();
    await panel.getByText("已开启，等待连接", { exact: true }).waitFor();
    assert.equal(
      fs.statSync(path.join(userData, "handoff.sock")).mode & 0o777,
      0o600,
    );

    const granted = client.call("get_project_context", {
      project: "机器人项目",
      reason: "继续实现舵机驱动",
    });
    const card = panel.getByRole("article", {
      name: "smoke-agent 的读取请求",
    });
    await card.waitFor();
    await panel
      .getByRole("navigation", { name: "设置分组" })
      .getByLabel("1 个待批准")
      .waitFor();
    await card.getByText("它给出的理由：继续实现舵机驱动").waitFor();
    const preview = card.getByLabel("将发送的内容");
    await preview.waitFor();
    const previewText = await preview.innerText();
    assert(previewText.includes("# Otter 项目交接：机器人项目测试"));
    assert(previewText.includes("验证项目进度续接"));
    await panel.screenshot({ path: path.join(output, "otter-handoff.png") });
    await card
      .getByRole("button", { name: "30 分钟内允许", exact: true })
      .click();
    const first = await granted;
    assert.equal(first.isError, false);
    assert.equal(first.content[0].text.trim(), previewText.trim());

    const automatic = await client.call("get_project_context", {});
    assert.equal(automatic.content[0].text, first.content[0].text);
    await panel.getByText("授权内自动发送").first().waitFor();
    await panel.getByRole("button", { name: "撤销", exact: true }).click();
    const declined = client.call("get_project_context", {});
    await card.waitFor();
    await card
      .getByRole("combobox", { name: "要分享的项目" })
      .selectOption({ label: "机器人项目测试" });
    await card.getByRole("button", { name: "拒绝", exact: true }).click();
    const refusal = await declined;
    assert(refusal.isError && refusal.content[0].text.includes("拒绝"));

    const proposal = await client.call("propose_progress", {
      project: "机器人项目测试",
      completed: ["MCP 交接已打通"],
      next: ["接入真实 Claude Code"],
      note: "分支 feat/handoff",
    });
    assert(proposal.content[0].text.includes("用户检查确认后才会保存"));
    const inbox = panel.getByRole("article", {
      name: "smoke-agent 交来的进度",
    });
    await inbox.getByText("MCP 交接已打通").waitFor();
    assert.equal(
      (await getProject("机器人项目测试")).snapshots[0].items.some(
        (i) => i.content === "MCP 交接已打通",
      ),
      false,
    );
    await inbox
      .getByRole("button", { name: "检查并保存", exact: true })
      .click();
    await panel
      .getByText("这些条目是 AI 工具的自述", { exact: false })
      .waitFor();
    await panel
      .getByRole("button", { name: "确认保存快照", exact: true })
      .click();
    await panel.getByText("进度已保存到项目。", { exact: true }).waitFor();
    const saved = (await getProject("机器人项目测试")).snapshots[0];
    assert.deepEqual(
      saved.items.map((i) => i.content),
      ["MCP 交接已打通", "接入真实 Claude Code"],
    );
    assert(saved.sources[0].label.startsWith("smoke-agent 交来的进度"));
    await panel.getByText("交来的进度 · 0", { exact: true }).waitFor();

    const results = await panel.evaluate(async () =>
      (await window.otter.action("handoff.get")).log.map((e) => e.result),
    );
    assert.deepEqual(results.slice(0, 4), [
      "received",
      "denied",
      "granted",
      "allowed-grant",
    ]);
    await panel
      .getByRole("checkbox", { name: "允许 AI 工具连接 Otter", exact: true })
      .click();
    await panel.getByText("已关闭", { exact: true }).waitFor();
    assert(!fs.existsSync(path.join(userData, "handoff.sock")));
    assert(
      await pet.evaluate(async () => {
        try {
          await window.otter.action("handoff.get");
          return false;
        } catch {
          return true;
        }
      }),
    );
  } finally {
    client.close();
  }
  console.log(
    "PASS: AI handoff via real MCP process: closed-channel error, enable, approval preview equals sent text, 30-minute grant reuse and revoke, decline, proposal inbox reviewed into a snapshot, access log, disable removes socket, pet denied.",
  );
}
module.exports = { verifyHandoff };
