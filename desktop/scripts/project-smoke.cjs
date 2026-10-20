const assert = require("node:assert/strict");
const path = require("node:path");
function projectModelReply(purpose, payload) {
  if (purpose === "[Otter project snapshot]") {
    const source = payload.sources.find((s) =>
      s.content.startsWith("项目记录测试："),
    );
    if (!source) return { items: [] };
    return {
      items: [
        ["completed", "串口连接已验证通过"],
        ["blocker", "舵机抖动"],
        ["next", "测试独立供电"],
      ].map(([kind, content]) => ({
        kind,
        content,
        source_ids: [source.id],
        evidence: [{ source_id: source.id, quote: content }],
      })),
    };
  }
  const current = payload.tasks?.current_project;
  if (payload.text === "今天先做到这里，保存项目进度")
    return { kind: "project_capture", project_id: current };
  if (payload.text === "把项目下一步加入待办")
    return { kind: "project_todo", project_id: current };
  if (payload.text === "回到这个项目的工作页面") {
    const project = payload.tasks.projects.find((p) => p.id === current);
    return {
      kind: "project_open",
      project_id: current,
      link_id: project.links[0].id,
    };
  }
  if (payload.text === "继续机器人项目测试")
    return {
      kind: "project_resume",
      project_id: payload.tasks.projects.find(
        (p) => p.name === "机器人项目测试",
      ).id,
    };
  if (payload.text === "这个项目接下来做什么")
    return { kind: "project_resume", project_id: current };
  return null;
}
async function verifyProjects({
  panel,
  pet,
  apiUrl,
  requests,
  projectRequests,
  output,
}) {
  const input = () =>
    panel.getByRole("textbox", { name: "聊天输入", exact: true });
  const send = async (text) => {
    await input().fill(text);
    await panel.getByRole("button", { name: "发送", exact: true }).click();
  };
  const chat = () =>
    panel.getByRole("button", { name: "与水獭聊天", exact: false }).click();
  const projects = () =>
    panel.getByRole("button", { name: "项目与进度", exact: false }).click();
  const getProject = (id) =>
    panel.evaluate(
      (id) => window.otter.call("projects.get", { project_id: id }),
      id,
    );
  await projects();
  await panel.getByRole("button", { name: "新建项目", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("机器人项目测试");
  await panel
    .getByRole("textbox", { name: "项目目标", exact: true })
    .fill("验证项目进度续接");
  await panel
    .getByRole("button", { name: "添加资料链接", exact: true })
    .click();
  await panel
    .getByRole("textbox", { name: "资料名称 1", exact: true })
    .fill("测试文档");
  await panel
    .getByRole("textbox", { name: "资料网址 1", exact: true })
    .fill(apiUrl.replace("/v1", "/action-target"));
  await panel.getByRole("button", { name: "保存项目", exact: true }).click();
  await panel
    .getByRole("button", { name: "手动记录进度", exact: true })
    .click();
  await panel
    .getByRole("textbox", { name: "进度内容 1", exact: true })
    .fill("验证供电");
  await panel
    .getByRole("button", { name: "确认保存快照", exact: true })
    .click();
  await panel.getByText("进度快照已保存。", { exact: true }).waitFor();
  const projectId = await panel.evaluate(
    async () =>
      (await window.otter.call("projects.list")).find(
        (p) => p.name === "机器人项目测试",
      ).id,
  );
  await panel.getByRole("button", { name: "加入待办", exact: true }).click();
  await panel.getByText(/已加入本项目待办/).waitFor();
  await panel.getByRole("button", { name: "加入待办", exact: true }).click();
  assert.equal(
    await panel.evaluate(
      async (id) =>
        (await window.otter.action("assistant.get")).todos.filter(
          (t) => t.projectId === id,
        ).length,
      projectId,
    ),
    1,
  );
  await panel
    .getByRole("button", { name: "继续这个项目", exact: true })
    .click();
  await panel
    .getByRole("combobox", { name: "关联项目", exact: true })
    .waitFor();
  await panel.waitForFunction(
    (id) =>
      document.querySelector('select[aria-label="关联项目"]')?.value === id,
    projectId,
  );
  const count = await panel.locator(".chat-message.assistant").count();
  const sourceText =
    "项目记录测试：串口连接已验证通过。当前问题是舵机抖动。下一步测试独立供电。";
  await send(sourceText);
  await panel.waitForFunction(
    (count) =>
      document.querySelectorAll(".chat-message.assistant").length > count,
    count,
  );
  await panel
    .getByRole("button", { name: "停止回复", exact: true })
    .waitFor({ state: "detached" });
  assert(requests.at(-1).body.messages[0].content.includes("验证供电"));
  await send("今天先做到这里，保存项目进度");
  const capture = panel.getByRole("region", { name: "保存项目进度" });
  await capture.waitFor();
  await capture.getByRole("button", { name: /整理已选内容/ }).waitFor();
  for (const checkbox of await capture.getByRole("checkbox").all())
    await checkbox.uncheck();
  await capture
    .locator("article")
    .filter({ hasText: sourceText })
    .getByRole("checkbox")
    .check();
  await capture.getByRole("button", { name: /整理已选内容/ }).click();
  await capture
    .getByRole("textbox", { name: "进度内容 3", exact: true })
    .fill("测试稳压电源");
  assert.equal(projectRequests.at(-1).sources.length, 1);
  assert.equal((await getProject(projectId)).snapshots.length, 1);
  await panel.screenshot({
    path: path.join(output, "otter-project-draft.png"),
  });
  await capture
    .getByRole("button", { name: "确认保存快照", exact: true })
    .click();
  await capture.waitFor({ state: "detached" });
  await panel.waitForFunction(
    async (id) =>
      (await window.otter.call("projects.get", { project_id: id })).snapshots
        .length === 2,
    projectId,
  );
  const saved = (await getProject(projectId)).snapshots[0];
  assert(saved.items.find((i) => i.kind === "next").edited);
  assert(saved.sources[0].content.includes(sourceText));
  await send("继续机器人项目测试");
  await panel
    .getByText(/以下是上次确认保存的进度/)
    .last()
    .waitFor();
  await panel.waitForFunction(() =>
    [...document.querySelectorAll(".chat-message.assistant")].some((e) =>
      e.textContent.includes("测试稳压电源"),
    ),
  );
  await send("把项目下一步加入待办");
  await panel.getByRole("button", { name: "确认执行", exact: true }).click();
  await panel.getByText("已添加待办：测试稳压电源", { exact: true }).waitFor();
  await send("回到这个项目的工作页面");
  await panel.getByRole("button", { name: "取消操作", exact: true }).click();
  await projects();
  await panel
    .getByRole("button", { name: "选择项目 机器人项目测试", exact: true })
    .click();
  await panel.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "继续这个项目" && !b.disabled,
    ),
  );
  await panel.screenshot({ path: path.join(output, "otter-projects.png") });
  await panel.locator(".project-snapshot").first().scrollIntoViewIfNeeded();
  await panel.screenshot({
    path: path.join(output, "otter-project-progress.png"),
  });
  await panel.getByRole("button", { name: "新建项目", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("另一个项目测试");
  await panel.getByRole("button", { name: "保存项目", exact: true }).click();
  await panel
    .getByRole("button", { name: "手动记录进度", exact: true })
    .click();
  await panel
    .getByRole("textbox", { name: "进度内容 1", exact: true })
    .fill("另一项目专属进度");
  await panel
    .getByRole("button", { name: "确认保存快照", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "继续这个项目", exact: true })
    .click();
  await panel
    .getByRole("combobox", { name: "关联项目", exact: true })
    .waitFor();
  const before = await panel.locator(".chat-message.assistant").count();
  await send("帮我梳理一下");
  await panel.waitForFunction(
    (count) =>
      document.querySelectorAll(".chat-message.assistant").length > count,
    before,
  );
  await panel
    .getByRole("button", { name: "停止回复", exact: true })
    .waitFor({ state: "detached" });
  assert(requests.at(-1).body.messages[0].content.includes("另一项目专属进度"));
  assert(!requests.at(-1).body.messages[0].content.includes("测试稳压电源"));
  await projects();
  await panel
    .getByRole("button", { name: "选择项目 另一个项目测试", exact: true })
    .click();
  await panel.getByRole("button", { name: "归档项目", exact: true }).click();
  await panel.getByRole("button", { name: "恢复项目", exact: true }).waitFor();
  await chat();
  await panel.waitForFunction(
    () => document.querySelector('select[aria-label="关联项目"]')?.value === "",
  );
  assert(
    await pet.evaluate(async () => {
      try {
        await window.otter.call("projects.list");
        return false;
      } catch {
        return true;
      }
    }),
  );
  console.log(
    "PASS: project cards, manual and model snapshots, selected sources, edit confirmation, project isolation, resume, next-step todos, saved link preview and archive.",
  );
}
module.exports = { projectModelReply, verifyProjects };
