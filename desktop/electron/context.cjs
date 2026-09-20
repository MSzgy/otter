const { execFile } = require("node:child_process");
function selectionRead(executable, permissionOnly = false) {
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      permissionOnly ? ["--permission-status"] : [],
      { timeout: 6000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error("选区读取工具暂不可用，请重新打开应用或重新构建安装包。"),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("无法读取选区。"));
        }
      },
    ),
  );
}
function buildScene(state) {
  if (!state.enabled) throw new Error("请先开启应用感知，再选择要讨论的场景。");
  const parts = [];
  const front = state.lastExternal || state.front;
  if (front) {
    parts.push(
      `应用：${front.name}\n采样时间：${new Date(front.observedAt || state.updatedAt).toLocaleString()}`,
    );
  }
  if (state.browser) {
    parts.push(
      `最近读取的浏览器标签页（可能不是当前前台）：\n浏览器：${state.browser.name}\n标题：${state.browser.title}\n网址：${state.browser.url || "未提供"}\n读取时间：${new Date(state.browser.observedAt).toLocaleString()}\n仅有标题和网址，未读取网页正文。`,
    );
  }
  if (!parts.length)
    throw new Error("尚未感知到场景，请先切换到目标应用再试。");
  return parts.join("\n\n").slice(0, 5000);
}
function selectionDraft(result) {
  const errors = {
    permission_required:
      "需要 macOS 辅助功能权限。请在系统设置中允许 Otter；若系统列出选区助手，也需允许该助手，然后重启 Otter。",
    empty:
      "没有读到选中文字。请先在原应用选中文本，再按选区快捷键；也可以手动粘贴。",
    unsupported: "当前应用没有提供可读取的选区，请手动粘贴文字。",
    protected: "受保护的输入框不会被读取。",
    no_app: "没有识别到前台应用。",
  };
  if (result.status !== "ready")
    throw new Error(errors[result.status] || "暂时无法读取选区。");
  if (typeof result.text !== "string" || !result.text.trim())
    throw new Error(errors.empty);
  return `来源应用：${String(result.app || "Unknown").slice(0, 160)}\n选中文字${result.truncated ? "（已截取前 3500 字）" : ""}：\n${result.text.slice(0, 3500)}`;
}
class ContextDraft {
  constructor() {
    this.value = null;
    this.sequence = 0;
  }
  set(text, label) {
    this.value = {
      id: String(++this.sequence),
      text: text.slice(0, 24000),
      label,
      createdAt: Date.now(),
    };
    return this.get();
  }
  get() {
    if (this.value && Date.now() - this.value.createdAt > 10 * 60 * 1000)
      this.value = null;
    return this.value ? { ...this.value } : null;
  }
  clear(id) {
    if (!id || this.value?.id === id) this.value = null;
  }
}
module.exports = { selectionRead, selectionDraft, buildScene, ContextDraft };
