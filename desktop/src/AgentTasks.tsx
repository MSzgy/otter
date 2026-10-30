import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import "./types";

export type AgentTask = {
  id: string;
  agent: string;
  title: string;
  prompt: string;
  cwd: string;
  access: "read" | "write";
  sessionId: string;
  status: "running" | "done" | "failed" | "stopped" | "interrupted";
  statusText: string;
  created: number;
  ended: number | null;
  progress?: string;
  result: string;
  changes: string[];
  error: string;
};
type Agent = {
  id: string;
  label: string;
  checked: boolean;
  ok?: boolean;
  path?: string;
  version?: string;
  login?: string;
  reason?: string;
};
export type Agents = {
  agents: Agent[];
  defaultFolder: string;
  tasks: AgentTask[];
};

const api = window.otter;
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);
}
const short = (p = "") => p.replace(/^\/Users\/[^/]+/, "~");
function elapsed(from: number, to: number) {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
// A link in a reply: web pages open in the browser; a local path (agents
// link the files they touched) is shown in Finder.
export function openHref(href: string) {
  return api.action(
    /^(\/|file:)/.test(href) ? "reveal-file" : "open-link",
    href,
  );
}
export const agentName = (agents: Agents | null, id: string) =>
  agents?.agents.find((a) => a.id === id)?.label || id;

// The agents and their tasks, kept current from main's agents.changed.
export function useAgents() {
  const [agents, setAgents] = useState<Agents | null>(null);
  useEffect(() => {
    void api
      .action<Agents>("agents.get")
      .then(setAgents)
      .catch(() => {});
    return api.subscribe((event) => {
      if (event.type === "agents.changed") setAgents(event.data);
    });
  }, []);
  return [agents, setAgents] as const;
}
// Re-renders every second while something runs, for the elapsed time.
function useClock(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

// Above the chat box: what this conversation has handed out and is still
// running, with how long and what it is doing now.
export function AgentStrip({ sessionId }: { sessionId: string }) {
  const [agents] = useAgents();
  const running = (agents?.tasks || []).filter(
    (t) => t.status === "running" && t.sessionId === sessionId,
  );
  const now = useClock(running.length > 0);
  const [error, setError] = useState("");
  if (!running.length) return null;
  return (
    <section className="agent-strip" aria-label="进行中的代理任务">
      {running.map((t) => (
        <div key={t.id} className="agent-run" role="status">
          <span className="agent-pulse" aria-hidden="true" />
          <strong>{agentName(agents, t.agent)}</strong>
          <span className="agent-title" title={t.prompt}>
            {t.title}
          </span>
          <small className="agent-progress">{t.progress || "进行中"}</small>
          <small className="agent-time">{elapsed(t.created, now)}</small>
          <button
            className="ghost"
            aria-label={`停止 ${t.title}`}
            onClick={() =>
              void api
                .action("agents.stop", { id: t.id })
                .catch((e) => setError(message(e)))
            }
          >
            停止
          </button>
        </div>
      ))}
      {error && <small className="alert">{error}</small>}
    </section>
  );
}

// 设置 → AI 代理: which agents this Mac has, the default folder, and every
// task with its result.
export function AgentsPane() {
  const [agents, setAgents] = useAgents();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useClock(!!agents?.tasks.some((t) => t.status === "running"));
  async function run(name: string, value?: unknown) {
    setError("");
    setBusy(true);
    try {
      const next = await api.action<Agents | null>(name, value);
      if (next) setAgents(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!agents) return error ? <p className="alert">{error}</p> : null;
  const finished = agents.tasks.filter((t) => t.status !== "running");
  return (
    <>
      <section className="settings-section" aria-label="代理和默认文件夹">
        <div className="setting-row">
          <div>
            <h2>AI 代理</h2>
            <p>
              在聊天里说“让 Codex 在 ~/项目
              里……”，水獭会把任务整理好交给它；确认卡片会写明文件夹、权限和任务。代理在后台做，做完后结果自动发回那个对话。之后会接入
              Claude Code 和 Grok。
            </p>
          </div>
          <button
            className="chat-new"
            disabled={busy}
            onClick={() => void run("agents.detect")}
          >
            {busy ? "检测中…" : "重新检测"}
          </button>
        </div>
        {agents.agents.map((a) => (
          <div key={a.id} className="setting-line agent-found">
            <span>
              <strong>{a.label}</strong>
              <small>
                {!a.checked
                  ? "检测中…"
                  : a.ok
                    ? `${a.version}${a.login ? ` · ${a.login}` : ""} · ${short(a.path)}`
                    : a.reason}
              </small>
            </span>
            <span className={`agent-badge ${a.ok ? "ok" : "bad"}`}>
              {!a.checked ? "…" : a.ok ? "可以用" : "用不了"}
            </span>
          </div>
        ))}
        <div className="setting-line">
          <span>
            默认文件夹
            <small>
              {agents.defaultFolder
                ? short(agents.defaultFolder)
                : "没设置：派任务时要说清楚在哪个文件夹"}
            </small>
          </span>
          <span className="ssh-actions">
            <button disabled={busy} onClick={() => void run("agents.folder")}>
              选择…
            </button>
            {agents.defaultFolder && (
              <button
                className="chat-link"
                disabled={busy}
                onClick={() => void run("agents.folder", null)}
              >
                清除
              </button>
            )}
          </span>
        </div>
        <p className="card-note">
          Codex
          用它自己的沙箱：只读任务不能改文件；可改文件的任务只能改那个文件夹，而且不联网。Otter
          不会让它跳过沙箱，也不会把整个磁盘或整个用户文件夹交给它改。
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="settings-section" aria-label="代理任务">
        <div className="setting-row">
          <div>
            <h2>任务</h2>
            <p>最近 50 个。Otter 退出时还在做的任务会中断。</p>
          </div>
          {finished.length > 0 && (
            <button
              className="chat-link"
              disabled={busy}
              onClick={() => void run("agents.clear")}
            >
              清除已结束的
            </button>
          )}
        </div>
        {!agents.tasks.length && <p className="card-empty">还没有派过任务。</p>}
        {agents.tasks.map((t) => (
          <article
            key={t.id}
            className="agent-task"
            aria-label={`任务：${t.title}`}
          >
            <div className="setting-line">
              <span>
                <strong>{t.title}</strong>
                <small>
                  {agentName(agents, t.agent)} · {short(t.cwd)} ·{" "}
                  {t.access === "write" ? "可改文件" : "只读"} ·{" "}
                  {new Date(t.created).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {" · "}
                  {elapsed(t.created, t.ended || now)}
                </small>
              </span>
              <span className="ssh-actions">
                <span className={`agent-badge ${t.status}`}>
                  {t.statusText}
                </span>
                {t.status === "running" ? (
                  <button
                    aria-label={`停止 ${t.title}`}
                    onClick={() => void run("agents.stop", { id: t.id })}
                  >
                    停止
                  </button>
                ) : (
                  <button
                    className="chat-link"
                    aria-label={`删除记录 ${t.title}`}
                    onClick={() => void run("agents.remove", { id: t.id })}
                  >
                    删除
                  </button>
                )}
              </span>
            </div>
            {t.status === "running" && (
              <p className="agent-progress">{t.progress || "进行中"}</p>
            )}
            {t.error && t.status !== "running" && (
              <p className="ssh-result bad">{t.error}</p>
            )}
            <details>
              <summary>{t.result ? "结果和任务说明" : "任务说明"}</summary>
              {t.result && (
                <div className="agent-result">
                  <Markdown
                    skipHtml
                    components={{
                      img: () => null,
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          onClick={(e) => {
                            e.preventDefault();
                            if (href)
                              void openHref(href).catch((e) =>
                                setError(message(e)),
                              );
                          }}
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {t.result}
                  </Markdown>
                </div>
              )}
              {t.changes.length > 0 && (
                <p className="card-note">
                  改动的文件：{t.changes.map((f) => short(f)).join("、")}
                </p>
              )}
              <pre className="agent-prompt">{t.prompt}</pre>
              {t.sessionId && (
                <button
                  className="chat-link"
                  onClick={() => void run("agents.open", { id: t.id })}
                >
                  打开派这个任务的对话
                </button>
              )}
            </details>
          </article>
        ))}
      </section>
    </>
  );
}
