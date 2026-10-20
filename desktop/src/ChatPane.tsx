import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { ProjectCapture } from "./ProjectCapture";
import { MemorySuggestions } from "./MemorySuggestions";
import { VoiceControls } from "./VoiceControls";
import { Otter } from "./Otter";
import type {
  Health,
  ChatTurn,
  MemoryRef,
  Project,
  ProjectInfo,
} from "./types";
type Session = { id: string; title: string };
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  error: string;
  session_id: string;
  context?: string;
  memory_refs?: MemoryRef[];
};
type Attachment = {
  id: string;
  text: string;
  label: string;
  createdAt: number;
};
const api = window.otter;
export function ChatPane({
  health,
  onSettings,
  onEditMemory,
  onProjects,
}: {
  health: Health | null;
  onSettings: () => void;
  onEditMemory: (id: string) => void;
  onProjects: (id?: string) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [useMemory, setUseMemory] = useState(true);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [boundProject, setBoundProject] = useState<Project | null>(null);
  const [captureProject, setCaptureProject] = useState<string | null>(null);
  async function refreshProject(id: string) {
    const [rows, bound] = await Promise.all([
      api.call<ProjectInfo[]>("projects.list"),
      api.call<Project | null>("projects.binding", { session_id: id }),
    ]);
    if (sessionRef.current === id) {
      setProjects(rows);
      setBoundProject(bound);
    }
  }
  useEffect(() => {
    if (!session || !health) return;
    return api.subscribe((e) => {
      if (e.type === "projects.changed")
        void refreshProject(session).catch(fail);
    });
  }, [session, !!health]);
  async function bindProject(id: string) {
    setSending(true);
    try {
      setBoundProject(
        await api.call<Project | null>("projects.bind", {
          session_id: session,
          project_id: id || null,
        }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }

  type TaskProposal = {
    kind: "proposal";
    id: string;
    title: string;
    detail: string;
    action: string;
    expiresAt: number;
  };
  type TaskResult = {
    kind: "result";
    message: string;
    ok: boolean;
    warning: string;
  };
  const [allowTasks, setAllowTasks] = useState(true);
  const [tasksReady, setTasksReady] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [taskProposal, setTaskProposal] = useState<TaskProposal | null>(null);
  const [taskNotice, setTaskNotice] = useState("");
  const [taskFailed, setTaskFailed] = useState(false);
  const taskRequest = useRef<string | null>(null);
  const skipTask = useRef(false);
  useEffect(() => {
    let alive = true;
    void api
      .action<{ enabled: boolean }>("tasks.settings")
      .then((value) => {
        if (alive) {
          setAllowTasks(value.enabled);
          setTasksReady(true);
        }
      })
      .catch(() => {
        if (alive) {
          setAllowTasks(false);
          setTasksReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  async function configureTasks(enabled: boolean) {
    const previous = allowTasks;
    setAllowTasks(enabled);
    setTasksReady(false);
    try {
      const result = await api.action<{ enabled: boolean }>("tasks.configure", {
        enabled,
      });
      setAllowTasks(result.enabled);
    } catch (e) {
      setAllowTasks(previous);
      fail(e);
    } finally {
      setTasksReady(true);
    }
  }
  function cancelTask() {
    const requestId = taskRequest.current;
    taskRequest.current = null;
    if (requestId)
      void api.action("tasks.cancel", { requestId }).catch(() => {});
    setTaskProposal(null);
    setPlanning(false);
  }
  useEffect(
    () => () => {
      if (taskRequest.current)
        void api
          .action("tasks.cancel", { requestId: taskRequest.current })
          .catch(() => {});
      taskRequest.current = null;
    },
    [],
  );
  async function showTaskResult(result: TaskResult, selected: string) {
    setDraft("");
    await choose(selected);
    setTaskNotice(result.warning ? `${result.message}\n${result.warning}` : "");
    await refreshSessions();
    await refreshProject(selected);
  }
  async function confirmTask() {
    if (!taskProposal || sending) return;
    setSending(true);
    setError("");
    try {
      const result = await api.action<TaskResult>("tasks.confirm", {
        id: taskProposal.id,
        sessionId: session,
      });
      await showTaskResult(result, session);
    } catch (e) {
      cancelTask();
      setTaskFailed(true);
      fail(e);
    } finally {
      setSending(false);
    }
  }
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [contextError, setContextError] = useState("");
  useEffect(() => {
    let alive = true,
      revision = 0;
    const off = api.subscribe((event) => {
      if (event.type === "context.draft") {
        revision++;
        setAttachment(event.data);
        setContextError("");
      }
      if (event.type === "context.error") {
        revision++;
        setContextError(event.data.message);
      }
    });
    const version = revision;
    void api
      .action<{ draft: Attachment | null; error: string }>("context.get")
      .then((value) => {
        if (alive && revision === version) {
          setAttachment(value.draft);
          setContextError(value.error);
        }
      });
    return () => {
      alive = false;
      off();
    };
  }, []);
  async function removeAttachment() {
    const id = attachment?.id;
    setAttachment(null);
    setContextError("");
    await api.action("context.clear", id);
  }

  const [turn, setTurn] = useState<ChatTurn | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const sessionRef = useRef("");
  const request = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const eventRevision = useRef(0);
  const active = turn?.status === "streaming";
  const busy = !!active || sending || planning || !!captureProject;
  const supported = health && ["mock", "openai"].includes(health.provider);
  function fail(e: unknown) {
    setError(
      e instanceof Error
        ? e.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          )
        : String(e),
    );
  }
  function applyTurn(value: ChatTurn) {
    setTurn(value);
    if (value.session_id !== sessionRef.current) return;
    setMessages((rows) => {
      const message: Message = {
        id: value.id,
        role: "assistant",
        content: value.content,
        status: value.status,
        error: value.error,
        session_id: value.session_id,
        memory_refs: value.memory_refs,
      };
      return rows.some((r) => r.id === value.id)
        ? rows.map((r) => (r.id === value.id ? message : r))
        : [...rows, message];
    });
  }
  async function choose(id: string) {
    cancelTask();
    setTaskNotice("");
    setTaskFailed(false);
    setBoundProject(null);
    const generation = ++request.current;
    sessionRef.current = id;
    setSession(id);
    setMessages([]);
    setLoading(true);
    setError("");
    setDeleting(false);
    const revision = eventRevision.current;
    try {
      const rows = await api.call<Message[]>("chat.history", {
        session_id: id,
      });
      if (generation === request.current) {
        await refreshProject(id);
        setMessages((current) =>
          eventRevision.current === revision
            ? rows
            : rows.map((r) => current.find((c) => c.id === r.id) || r),
        );
      }
    } catch (e) {
      if (generation === request.current) fail(e);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }
  async function refreshSessions() {
    const rows = await api.call<Session[]>("chat.sessions");
    setSessions(rows);
    return rows;
  }
  useEffect(() => {
    if (!health) {
      setLoading(false);
      setTurn(null);
      return;
    }
    let alive = true;
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "chat.changed") {
        eventRevision.current++;
        applyTurn(event.data);
        if (event.data.status === "complete")
          void api.action("voice.reply", event.data.id).catch(fail);
        if (event.data.status !== "streaming")
          void refreshSessions().catch(fail);
      }
      if (event.type === "navigation" && event.data.view === "chat")
        textarea.current?.focus();
    });
    (async () => {
      try {
        const rows = await api.call<Session[]>("chat.sessions");
        if (!alive) return;
        setSessions(rows);
        const selected = rows[0] || (await api.call<Session>("chat.new"));
        if (!alive) return;
        if (!rows.length) setSessions([selected]);
        await choose(selected.id);
        const state = await api.call<ChatTurn | null>("chat.state");
        if (alive && state) applyTurn(state);
      } catch (e) {
        if (alive) {
          fail(e);
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      request.current++;
      unsubscribe();
    };
  }, [!!health]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages.at(-1)?.content, session]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy || !supported || !session || !tasksReady) return;
    const bypass = skipTask.current;
    skipTask.current = false;
    if (taskProposal && !bypass) return;
    if (allowTasks && !attachment && !bypass) {
      const requestId = crypto.randomUUID();
      taskRequest.current = requestId;
      setPlanning(true);
      setError("");
      setTaskNotice("");
      setTaskFailed(false);
      try {
        const result = await api.action<
          | TaskProposal
          | TaskResult
          | { kind: "capture"; projectId: string; sessionId: string }
          | { kind: "chat" | "cancelled" }
        >("tasks.plan", { text: draft.trim(), sessionId: session, requestId });
        if (taskRequest.current !== requestId) return;
        if (result.kind === "capture") {
          setCaptureProject(result.projectId);
          setDraft("");
          return;
        }
        if (result.kind === "proposal") {
          setTaskProposal(result);
          return;
        }
        if (result.kind === "result") {
          await showTaskResult(result, session);
          return;
        }
        if (result.kind === "cancelled") return;
      } catch (e) {
        if (taskRequest.current === requestId) {
          setTaskFailed(true);
          fail(e);
        }
        return;
      } finally {
        if (taskRequest.current === requestId) setPlanning(false);
      }
    }
    const text = draft.trim(),
      id = crypto.randomUUID().replaceAll("-", ""),
      selected = session;
    const attached = attachment;
    setSending(true);
    setError("");
    setDraft("");
    setMessages((rows) => [
      ...rows,
      {
        id: id + "-user",
        role: "user",
        content: text,
        status: "complete",
        error: "",
        session_id: selected,
        context: attached?.text || "",
      },
    ]);
    const revision = eventRevision.current;
    try {
      const result = await api.call<ChatTurn>("chat.send", {
        session_id: selected,
        text,
        request_id: id,
        use_memory: useMemory,
        context: attached?.text || "",
      });
      setUseMemory(true);
      if (attached) {
        await api.action("context.clear", attached.id);
        setAttachment((current) =>
          current?.id === attached.id ? null : current,
        );
      }
      if (eventRevision.current === revision) applyTurn(result);
      await refreshSessions();
    } catch (e) {
      setDraft(text);
      await choose(selected);
      fail(e);
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }
  async function stop() {
    try {
      if (turn) await api.call("chat.cancel", { turn_id: turn.id });
      await api.action("voice.stop");
    } catch (e) {
      fail(e);
    }
  }
  async function newChat() {
    try {
      const created = await api.call<Session>("chat.new");
      await refreshSessions();
      await choose(created.id);
      textarea.current?.focus();
    } catch (e) {
      fail(e);
    }
  }
  async function deleteChat() {
    try {
      await api.call("chat.delete", { session_id: session });
      setTurn(null);
      const rows = await refreshSessions();
      if (rows[0]) await choose(rows[0].id);
      else await newChat();
    } catch (e) {
      fail(e);
    }
  }
  return (
    <section className="chat-pane" aria-label="与 Otter 聊天">
      <div className="chat-header">
        <div>
          <h1>和 Otter 聊聊。</h1>
          <p>
            {health?.demo
              ? "离线演示 · 配置模型后开启自由对话"
              : `${health?.model || health?.provider || "未连接"} · 你的水獭伙伴`}
          </p>
        </div>
        <button disabled={!health || busy} onClick={newChat}>
          新对话
        </button>
      </div>
      <div className="chat-project">
        <label>
          当前项目{" "}
          <select
            aria-label="关联项目"
            value={boundProject?.id || ""}
            disabled={busy || loading}
            onChange={(e) => void bindProject(e.target.value)}
          >
            <option value="">未关联项目</option>
            {projects
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <button disabled={busy} onClick={() => onProjects(boundProject?.id)}>
          管理项目
        </button>
        {boundProject && (
          <button
            disabled={busy || loading}
            onClick={() => setCaptureProject(boundProject.id)}
          >
            保存本段进度
          </button>
        )}
        {boundProject && (
          <small>
            聊天会引用这个项目最近确认的进度；切换关联会保留当前聊天历史。
          </small>
        )}
      </div>
      <div className="chat-session-row">
        <select
          aria-label="聊天记录"
          value={session}
          disabled={busy || loading}
          onChange={(e) => void choose(e.target.value)}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button
          disabled={!session || busy || loading}
          onClick={() => setDeleting(!deleting)}
        >
          删除对话
        </button>
      </div>
      {deleting && (
        <div className="chat-delete">
          删除本机这段对话及全部消息？
          <button onClick={deleteChat}>确认删除</button>
          <button onClick={() => setDeleting(false)}>保留</button>
        </div>
      )}
      {turn?.memory_mode === "keyword_fallback" && (
        <p className="muted">
          语义检索这次暂不可用，已使用关键词检索继续聊天。
        </p>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {!supported && health && (
        <div className="demo-note">
          当前模型还不支持聊天。
          <button onClick={onSettings}>配置 OpenAI 兼容模型 →</button>
        </div>
      )}
      <div className="chat-messages" aria-label="聊天消息" aria-busy={loading}>
        {loading ? (
          <p className="muted">正在打开对话…</p>
        ) : messages.length === 0 ? (
          <div className="chat-welcome">
            <Otter size={144} />
            <h2>我在这里，慢慢说。</h2>
            <p>聊聊今天，或者一起琢磨一个新想法。</p>
            <div>
              {["今天有点累", "陪我聊一个新点子", "你能帮我做什么？"].map(
                (text) => (
                  <button
                    key={text}
                    onClick={() => {
                      setDraft(text);
                      textarea.current?.focus();
                    }}
                  >
                    {text}
                  </button>
                ),
              )}
            </div>
            {health?.demo && (
              <button onClick={onSettings}>先连接我的模型 →</button>
            )}
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`chat-message ${m.role}`}>
              <div className="chat-author">
                {m.role === "user" ? "你" : "Otter 🦦"}
              </div>
              {m.role === "assistant" &&
                m.content &&
                m.status !== "streaming" && (
                  <button
                    className="read-message"
                    onClick={() =>
                      void api
                        .action("voice.speak", m.content.slice(0, 8000))
                        .catch(fail)
                    }
                  >
                    朗读
                  </button>
                )}
              {!!m.memory_refs?.length && (
                <MemoryRefs refs={m.memory_refs} onEdit={onEditMemory} />
              )}
              {m.context && (
                <details className="sent-context">
                  <summary>附带的上下文</summary>
                  <pre>{m.context}</pre>
                </details>
              )}
              <div className="chat-bubble">
                <Markdown
                  skipHtml
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href)
                            void api.action("open-link", href).catch(fail);
                        }}
                      >
                        {children}
                      </a>
                    ),
                    img: () => null,
                  }}
                >
                  {m.content || (m.status === "streaming" ? "让我想想…" : "")}
                </Markdown>
                {m.status === "streaming" && (
                  <span className="chat-cursor" aria-label="正在回复">
                    ●
                  </span>
                )}
              </div>
              {["cancelled", "interrupted", "error"].includes(m.status) && (
                <small className="chat-message-state">
                  {m.error ||
                    (m.status === "cancelled" ? "已停止回复" : "上次回复中断")}
                </small>
              )}
            </div>
          ))
        )}
        <div ref={end} />
      </div>
      {captureProject && (
        <ProjectCapture
          key={captureProject + session}
          projectId={captureProject}
          sessionId={session}
          onClose={() => setCaptureProject(null)}
          onSaved={() => {
            const id = captureProject;
            setCaptureProject(null);
            void bindProject(id);
            setTaskNotice("项目进度快照已保存，可以继续聊天或到项目页查看。");
          }}
        />
      )}
      {taskNotice && (
        <div className="alert" role="status">
          {taskNotice}
        </div>
      )}
      {taskProposal && (
        <section className="context-preview" aria-label="办事确认">
          <strong>{taskProposal.title}</strong>
          <p style={{ whiteSpace: "pre-wrap" }}>{taskProposal.detail}</p>
          <small>确认后执行，卡片一分钟内有效。</small>
          <div className="button-row">
            <button
              className="primary"
              disabled={sending}
              onClick={confirmTask}
            >
              {sending
                ? "执行中…"
                : taskProposal.action === "reminder_create"
                  ? "确认创建提醒"
                  : "确认执行"}
            </button>
            <button
              disabled={sending}
              onClick={() => {
                cancelTask();
                textarea.current?.focus();
              }}
            >
              修改要求
            </button>
            <button
              disabled={sending}
              onClick={() => {
                cancelTask();
                setDraft("");
              }}
            >
              取消操作
            </button>
            <button
              disabled={sending}
              onClick={() => {
                cancelTask();
                skipTask.current = true;
                textarea.current?.form?.requestSubmit();
              }}
            >
              仅聊天发送
            </button>
          </div>
        </section>
      )}
      {taskFailed && (
        <div className="button-row">
          <button
            disabled={busy}
            onClick={() => {
              setTaskFailed(false);
              textarea.current?.form?.requestSubmit();
            }}
          >
            重新理解
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setTaskFailed(false);
              skipTask.current = true;
              textarea.current?.form?.requestSubmit();
            }}
          >
            仅聊天发送
          </button>
        </div>
      )}
      {contextError && (
        <div className="alert" role="alert">
          {contextError}
          <button
            onClick={() => {
              setContextError("");
              void api.action("context.clear", attachment?.id);
            }}
          >
            关闭
          </button>
        </div>
      )}
      {attachment && (
        <section className="context-preview" aria-label="发送前上下文预览">
          <div>
            <strong>{attachment.label} · 发送前预览</strong>
            <button onClick={() => void removeAttachment()}>移除附件</button>
          </div>
          <textarea
            aria-label="附带上下文"
            maxLength={24000}
            value={attachment.text}
            onChange={(e) =>
              setAttachment((a) => (a ? { ...a, text: e.target.value } : null))
            }
          />
          <small>
            可以编辑。仅在发送消息时附带；发送后随聊天记录保存在本机。
          </small>
          <div className="context-prompts">
            {["解释这段内容", "翻译成中文", "提炼重点"].map((text) => (
              <button key={text} onClick={() => setDraft(text)}>
                {text}
              </button>
            ))}
          </div>
        </section>
      )}
      <VoiceControls
        enabled={health?.provider === "openai" && !busy && !taskProposal}
        onText={(text) =>
          setDraft((current) =>
            (current ? current + "\n" : "").concat(text).slice(0, 6000),
          )
        }
      />
      <div className="chat-context-actions">
        <button
          onClick={() =>
            void api
              .action("context.scene")
              .catch((e) => setContextError(e.message))
          }
        >
          附带当前场景
        </button>
        <label
          className="memory-toggle"
          title="说“记住：……”保存一条记忆；附件和网页内容不会自动成为记忆。"
        >
          <input
            type="checkbox"
            checked={useMemory}
            onChange={(e) => setUseMemory(e.target.checked)}
          />
          本轮使用记忆
        </label>
        <label className="memory-toggle">
          <input
            type="checkbox"
            checked={allowTasks}
            disabled={busy || !!taskProposal || !tasksReady}
            onChange={(e) => void configureTasks(e.target.checked)}
          />
          理解办事请求
        </label>
        <span>选中文字：⌘⇧E（可在设置中修改）</span>
      </div>
      <form className="chat-composer" onSubmit={send}>
        <textarea
          ref={textarea}
          aria-label="聊天输入"
          placeholder="和水獭说点什么…"
          maxLength={6000}
          value={draft}
          disabled={!supported || loading || planning || !!taskProposal}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (!busy) e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div>
          <span>Enter 发送 · Shift + Enter 换行</span>
          {planning ? (
            <button type="button" onClick={cancelTask}>
              停止理解
            </button>
          ) : active ? (
            <button type="button" onClick={stop}>
              停止回复
            </button>
          ) : (
            <button
              className="primary"
              disabled={
                !supported ||
                loading ||
                busy ||
                !tasksReady ||
                !!taskProposal ||
                !draft.trim()
              }
              type="submit"
            >
              {sending ? "发送中…" : "发送"}
            </button>
          )}
        </div>
      </form>
      {!!session && <MemorySuggestions key={session} sessionId={session} />}
      <p className="chat-privacy">
        开启办事理解时，输入、近期无附件聊天、部分提醒和待办，以及项目和资料名称会交给当前模型理解；操作先确认，查询直接返回。附带网页或窗口内容时按普通聊天处理。记录保存在本机。发送时携带当前会话的近期内容和相关记忆，不自动读取工作记录。说“记住：……”保存记忆，“忘掉刚才那条”撤回。
      </p>
    </section>
  );
}

function MemoryRefs({
  refs,
  onEdit,
}: {
  refs: MemoryRef[];
  onEdit: (id: string) => void;
}) {
  const used = refs.filter((r) => r.kind === "used");
  const changed = refs.filter((r) => r.kind !== "used");
  return (
    <div className="memory-refs">
      {changed.map((r) => (
        <p key={r.id + r.kind}>
          {r.kind === "saved" ? "已存入记忆" : "已从记忆删除"}：{r.title}
          {r.kind === "saved" && (
            <button onClick={() => onEdit(r.id)}>查看或修改</button>
          )}
        </p>
      ))}
      {!!used.length && (
        <details>
          <summary>本次参考的记忆 · {used.length}</summary>
          <ul>
            {used.map((r) => (
              <li key={r.id}>
                {r.title}
                <button onClick={() => onEdit(r.id)}>不对？去修改</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
