import { useEffect, useState } from "react";
import "./types";
type App = { name: string; bundleId: string; pid: number };
type Content = {
  id: string;
  app: App;
  method: string;
  status: string;
  permission: string | null;
  truncated: boolean;
  observedAt: number;
  windows: {
    id: string;
    title: string;
    text: string;
    protectedFieldsSkipped: boolean;
  }[];
};
const statusText: Record<string, string> = {
  permission_required: "需要系统授权，授权后重新读取即可。",
  labels_only: "只读到窗口标题或界面控件标签，未读到正文。请尝试窗口 OCR。",
  no_windows:
    "未找到可读取的窗口。请打开目标应用的文档窗口；OCR 需要窗口未最小化。",
  empty:
    "应用没有公开可读文字，或画面中没有识别到文字。可以切换另一种读取方式。",
  read_failed: "应用暂未响应或没有公开窗口内容，请尝试 OCR。",
  capture_failed: "窗口识别失败，请检查屏幕录制权限，并确认目标窗口已打开。",
  not_running: "应用已退出或进程已变化，请刷新应用列表。",
  unsupported_os: "当前 macOS 版本不支持窗口 OCR，需要 macOS 14 或更新版本。",
};
export function ApplicationContent({
  apps,
  enabled,
}: {
  apps: App[];
  enabled: boolean;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [permissions, setPermissions] = useState<{
    accessibility: boolean;
    screenRecording: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void window.otter
      .action<typeof permissions>("awareness.content-permissions")
      .then((p) => {
        if (active) setPermissions(p);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) setContent(null);
  }, [enabled]);
  async function read(app: App, method: string) {
    setPending(`${app.pid}:${method}`);
    setError("");
    setContent(null);
    try {
      setContent(
        await window.otter.action<Content>("awareness.content", {
          pid: app.pid,
          bundleId: app.bundleId,
          method,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending("");
    }
  }
  async function permission(kind: "accessibility" | "screen") {
    setPending("permission");
    setError("");
    try {
      setPermissions(
        await window.otter.action("awareness.request-permission", kind),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setPending("");
    }
  }
  async function check() {
    try {
      setPermissions(
        await window.otter.action("awareness.content-permissions"),
      );
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="app-content-reader" aria-label="应用窗口内容">
      <div className="section-title">
        <h2>读取应用里的内容</h2>
        <button disabled={!!pending} onClick={check}>
          重新检查权限
        </button>
      </div>
      <p className="awareness-hint">
        选择应用读取窗口文字；对于自绘界面、PDF 或图片，尝试窗口
        OCR。所有结果先在本机显示。
      </p>
      <div className="content-permissions">
        <span>
          窗口文字：
          {permissions
            ? permissions.accessibility
              ? "已授权"
              : "需要辅助功能权限"
            : "检查中…"}
        </span>
        <button
          disabled={!!pending}
          onClick={() => permission("accessibility")}
        >
          授权窗口文字读取
        </button>
        <span>
          OCR：
          {permissions
            ? permissions.screenRecording
              ? "已授权"
              : "需要屏幕录制权限"
            : "检查中…"}
        </span>
        <button disabled={!!pending} onClick={() => permission("screen")}>
          授权窗口 OCR
        </button>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {content && (
        <article className="application-text-result">
          <div className="section-title">
            <h2>
              {content.app.name} ·{" "}
              {content.method === "ocr" ? "窗口 OCR" : "窗口文字"}
            </h2>
            <time>{new Date(content.observedAt).toLocaleTimeString()}</time>
          </div>
          {content.status === "ready" ? (
            <>
              <p className="awareness-hint">
                {content.truncated
                  ? "达到读取上限，以下为部分内容。"
                  : "已读取应用窗口提供的文字。"}
                {content.method === "ocr"
                  ? "OCR 可能存在识别错误，不代表不可见或未加载的内容。"
                  : ""}
              </p>
              {content.windows.map((w) => (
                <details key={w.id} open>
                  <summary>{w.title}</summary>
                  <pre>{w.text || "这个窗口没有可读文字。"}</pre>
                  {w.protectedFieldsSkipped && (
                    <small>已跳过受保护输入框。</small>
                  )}
                </details>
              ))}
              <button
                className="primary"
                onClick={() =>
                  window.otter
                    .action("context.app", content.id)
                    .catch((e) => setError(e.message))
                }
              >
                用这些内容提问
              </button>
            </>
          ) : (
            <div role="status" className="awareness-hint">
              {statusText[content.status] || "暂时无法读取此应用。"}
              {content.permission === "accessibility"
                ? "需要在 macOS 辅助功能中允许 Otter/窗口读取助手。"
                : content.permission === "screen_recording"
                  ? "需要在 macOS 屏幕录制中允许 Otter/窗口读取助手。"
                  : ""}
            </div>
          )}
        </article>
      )}
      <div className="app-content-list">
        {apps.map((app) => (
          <article key={`${app.bundleId}:${app.pid}`} data-app-pid={app.pid}>
            <div>
              <strong>{app.name}</strong>
              <small>{app.bundleId || "此应用没有 bundle identifier"}</small>
            </div>
            <div className="button-row">
              <button
                disabled={!enabled || !!pending}
                onClick={() => read(app, "ax")}
              >
                {pending === `${app.pid}:ax` ? "正在读取…" : "读取窗口文字"}
              </button>
              <button
                disabled={!enabled || !!pending}
                onClick={() => read(app, "ocr")}
              >
                {pending === `${app.pid}:ocr` ? "正在识别…" : "窗口 OCR"}
              </button>
            </div>
          </article>
        ))}
      </div>
      <p className="awareness-hint">
        OCR
        会临时截取所选应用的窗口并在本机识别，不保存截图。窗口文字读取会跳过系统标记的受保护字段；未加载的内容、受保护画面或应用未公开的内容不一定能读取。
      </p>
    </section>
  );
}
