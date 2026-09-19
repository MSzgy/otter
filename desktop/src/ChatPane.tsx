import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Otter } from "./Otter";
import type { Health, ChatTurn } from "./types";
type Session = { id: string; title: string };
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  error: string;
  session_id: string;
  context?: string;
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
}: {
  health: Health | null;
  onSettings: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
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
  const busy = !!active || sending;
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
      };
      return rows.some((r) => r.id === value.id)
        ? rows.map((r) => (r.id === value.id ? message : r))
        : [...rows, message];
    });
  }
  async function choose(id: string) {
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
    if (!draft.trim() || busy || !supported || !session) return;
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
        context: attached?.text || "",
      });
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
            maxLength={5000}
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
        <span>选中文字：⌘⇧E（可在设置中修改）</span>
      </div>
      <form className="chat-composer" onSubmit={send}>
        <textarea
          ref={textarea}
          aria-label="聊天输入"
          placeholder="和水獭说点什么…"
          maxLength={6000}
          value={draft}
          disabled={!supported || loading}
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
          {active ? (
            <button type="button" onClick={stop}>
              停止回复
            </button>
          ) : (
            <button
              className="primary"
              disabled={!supported || loading || busy || !draft.trim()}
              type="submit"
            >
              {sending ? "发送中…" : "发送"}
            </button>
          )}
        </div>
      </form>
      <p className="chat-privacy">
        记录保存在本机。发送时仅携带当前会话的近期内容，不自动读取工作记录。
      </p>
    </section>
  );
}
