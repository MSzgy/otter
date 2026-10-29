import { useEffect, useState } from "react";
import { ProjectCapture } from "./ProjectCapture";
import type {
  HandoffProposal,
  HandoffRequest,
  HandoffState,
  ProjectInfo,
} from "./types";
const api = window.otter;
const KINDS = { completed: "已完成", blocker: "卡点", next: "下一步" };
const RESULTS: Record<string, string> = {
  allowed: "已允许一次",
  "allowed-grant": "已允许 30 分钟",
  granted: "授权内自动发送",
  denied: "已拒绝",
  timeout: "超时未处理",
  cancelled: "对方已取消",
  reset: "已作废",
  received: "已收下，待检查",
  error: "出错",
};
const CLIENTS = [
  {
    key: "claude",
    name: "Claude Code",
    hint: "在终端运行一次：",
  },
  {
    key: "codex",
    name: "Codex",
    hint: "加到 ~/.codex/config.toml：",
  },
  {
    key: "cursor",
    name: "Cursor",
    hint: "合并到 ~/.cursor/mcp.json：",
  },
] as const;
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);
}
function Request({
  request,
  now,
  onError,
}: {
  request: HandoffRequest;
  now: number;
  onError: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState(request.projectId);
  const [preview, setPreview] = useState<{
    text: string;
    hash: string;
    chars: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPreview(null);
    if (!projectId) return;
    let current = true;
    void api
      .action<{ text: string; hash: string; chars: number }>(
        "handoff.preview",
        { requestId: request.id, projectId },
      )
      .then((value) => current && setPreview(value))
      .catch((e) => current && onError(message(e)));
    return () => {
      current = false;
    };
  }, [projectId]);
  async function decide(decision: "once" | "grant" | "deny") {
    setBusy(true);
    try {
      await api.action("handoff.decide", {
        requestId: request.id,
        decision,
        projectId,
        hash: preview?.hash,
      });
    } catch (e) {
      onError(message(e));
      // The project may have changed under the preview; show the fresh one.
      void api
        .action<{ text: string; hash: string; chars: number }>(
          "handoff.preview",
          { requestId: request.id, projectId },
        )
        .then(setPreview)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const seconds = Math.max(
    0,
    Math.ceil((request.expiresAt - Math.max(now, request.createdAt)) / 1000),
  );
  return (
    <article
      className="handoff-request"
      aria-label={`${request.client.name} 的读取请求`}
    >
      <div className="section-title">
        <h3>
          {request.client.name}
          <small>（自报名称）</small>想读取项目进度
        </h3>
        <span className="handoff-countdown">{seconds} 秒内处理</span>
      </div>
      {request.reason && (
        <blockquote>它给出的理由：{request.reason}</blockquote>
      )}
      <label>
        要分享的项目
        {request.hint && <small>它要的是「{request.hint}」</small>}
        <select
          aria-label="要分享的项目"
          value={projectId}
          disabled={busy}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">请选择…</option>
          {request.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {preview && (
        <>
          <p className="muted">将发送以下内容，共 {preview.chars} 字：</p>
          <pre className="handoff-preview" aria-label="将发送的内容">
            {preview.text}
          </pre>
        </>
      )}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !preview}
          onClick={() => decide("once")}
        >
          允许这一次
        </button>
        <button disabled={busy || !preview} onClick={() => decide("grant")}>
          30 分钟内允许
        </button>
        <button disabled={busy} onClick={() => decide("deny")}>
          拒绝
        </button>
      </div>
    </article>
  );
}
export function HandoffPane() {
  const [state, setState] = useState<HandoffState | null>(null);
  const [inbox, setInbox] = useState<HandoffProposal[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState<{
    id: string;
    projectId: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  async function loadInbox() {
    const [rows, list] = await Promise.all([
      api.call<HandoffProposal[]>("projects.handoff-list"),
      api.call<ProjectInfo[]>("projects.list"),
    ]);
    setInbox(rows);
    setProjects(list.filter((p) => !p.archived));
  }
  useEffect(() => {
    let alive = true;
    const load = () => {
      void api
        .action<HandoffState>("handoff.get")
        .then((value) => alive && setState(value))
        .catch((e) => alive && setError(message(e)));
      void loadInbox().catch((e) => alive && setError(message(e)));
    };
    const off = api.subscribe((event) => {
      if (event.type === "handoff.changed") setState(event.data);
      if (
        event.type === "handoff.inbox" ||
        event.type === "projects.changed" ||
        (event.type === "connection" && event.data.status === "online")
      )
        void loadInbox().catch(() => {});
    });
    load();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, []);
  async function configure(enabled: boolean) {
    setError("");
    try {
      setState(
        await api.action<HandoffState>("handoff.configure", { enabled }),
      );
    } catch (e) {
      setError(message(e));
    }
  }
  async function dismiss(id: string) {
    try {
      await api.call("projects.handoff-dismiss", { handoff_id: id });
      await loadInbox();
      setNotice("已忽略这份交接。");
    } catch (e) {
      setError(message(e));
    }
  }
  async function copy(key: string, name: string) {
    try {
      await api.action("handoff.copy", key);
      setNotice(`已复制 ${name} 的接入配置。`);
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <section className="handoff-pane">
      {error && (
        <div className="alert" role="alert">
          {error}
          <button aria-label="关闭错误提示" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <p className="model-success" role="status">
          {notice}
        </p>
      )}
      <section className="settings-section">
        <div className="setting-row">
          <div>
            <h2>允许 AI 工具连接</h2>
            <p>
              Claude Code、Codex、Cursor
              经你批准后读取项目进度，也能把进度交回来。
            </p>
          </div>
          <input
            type="checkbox"
            className="toggle"
            aria-label="允许 AI 工具连接 Otter"
            checked={!!state?.enabled}
            disabled={!state}
            onChange={(e) => void configure(e.target.checked)}
          />
        </div>
        <p className="body-status">
          {!state
            ? "正在读取…"
            : state.error || (state.listening ? "已开启，等待连接" : "已关闭")}
        </p>
        <details className="settings-more">
          <summary>安全边界</summary>
          <p>
            AI 工具只能连接正在运行的
            Otter，碰不到数据库文件。每次读取都会在这里请你批准；交回的进度先进收件箱，检查确认后才保存。
          </p>
          <p>
            AI 工具的名称由它自己报告，无法核实；“30
            分钟内允许”按名称和项目生效。这能防止 AI
            工具悄悄拿走上下文，但防不住以你身份运行的恶意程序。当前只分享项目进度，不包括长期记忆和聊天记录。
          </p>
        </details>
      </section>
      {!!state?.pending.length && (
        <section className="settings-section" aria-label="待批准的请求">
          <h2>待批准 · {state.pending.length}</h2>
          {state.pending.map((r) => (
            <Request key={r.id} request={r} now={now} onError={setError} />
          ))}
        </section>
      )}
      <section className="settings-section" aria-label="交来的进度">
        <h2>交来的进度 · {inbox.length}</h2>
        {!inbox.length && (
          <p className="muted">
            还没有。AI 工具交回的进度会在这里等你确认，保留 7 天。
          </p>
        )}
        {inbox.map((h) => {
          const target = targets[h.id] ?? h.project_id ?? "";
          if (reviewing?.id === h.id)
            return (
              <ProjectCapture
                key={h.id}
                projectId={reviewing.projectId}
                handoffId={h.id}
                onClose={() => setReviewing(null)}
                onSaved={() => {
                  setReviewing(null);
                  setNotice("进度已保存到项目。");
                  void loadInbox();
                }}
              />
            );
          return (
            <article
              key={h.id}
              className="handoff-proposal"
              aria-label={`${h.client} 交来的进度`}
            >
              <small>
                {h.client}（自报名称） ·{" "}
                {new Date(h.created * 1000).toLocaleString()}
                {h.project_hint ? ` · 它说是「${h.project_hint}」` : ""}
              </small>
              <ul>
                {h.items.map((item, i) => (
                  <li key={i}>
                    <strong>{KINDS[item.kind]}</strong> {item.content}
                  </li>
                ))}
              </ul>
              {h.note && <p className="project-text">附注：{h.note}</p>}
              <div className="button-row">
                <select
                  aria-label="保存到项目"
                  value={target}
                  onChange={(e) =>
                    setTargets((t) => ({ ...t, [h.id]: e.target.value }))
                  }
                >
                  <option value="">选择项目…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={!target || !!reviewing}
                  onClick={() => {
                    setNotice("");
                    setReviewing({ id: h.id, projectId: target });
                  }}
                >
                  检查并保存
                </button>
                <button onClick={() => void dismiss(h.id)}>忽略</button>
              </div>
            </article>
          );
        })}
      </section>
      {!!state?.grants.length && (
        <section className="settings-section" aria-label="已授权">
          <h2>已授权</h2>
          {state.grants.map((g) => (
            <div className="setting-row" key={g.id}>
              <p>
                {g.client} 可读取「{g.projectName}」，还剩{" "}
                {Math.max(1, Math.ceil((g.expiresAt - now) / 60000))} 分钟
              </p>
              <button
                onClick={() =>
                  void api
                    .action<HandoffState>("handoff.revoke", g.id)
                    .then(setState)
                    .catch((e) => setError(message(e)))
                }
              >
                撤销
              </button>
            </div>
          ))}
        </section>
      )}
      <details
        className="settings-section settings-more handoff-clients"
        aria-label="接入 AI 工具"
      >
        <summary>接入 AI 工具</summary>
        <p className="muted">
          按下面的方式在工具里添加一次即可，Otter 不会改动它们的配置
          {state && !state.setup.packaged
            ? "；当前是开发版，命令指向源码目录"
            : ""}
          。
        </p>
        {state &&
          CLIENTS.map((c) => (
            <div className="handoff-setup" key={c.key}>
              <div className="section-title">
                <strong>{c.name}</strong>
                <button onClick={() => void copy(c.key, c.name)}>
                  复制 {c.name} 配置
                </button>
              </div>
              <small>{c.hint}</small>
              <pre>{state.setup.snippets[c.key]}</pre>
            </div>
          ))}
      </details>
      <section className="settings-section" aria-label="访问记录">
        <h2>访问记录</h2>
        {!state?.log.length ? (
          <p className="muted">还没有 AI 工具来过。</p>
        ) : (
          <table className="handoff-log">
            <tbody>
              {state.log.slice(0, 30).map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.at).toLocaleString()}</td>
                  <td>{e.client}</td>
                  <td>{e.kind === "context" ? "读取" : "交回"}</td>
                  <td>{e.project || "—"}</td>
                  <td>{RESULTS[e.result] || e.result}</td>
                  <td>{e.chars ? `${e.chars} 字` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
