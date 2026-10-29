import { useEffect, useRef, useState, type ReactNode } from "react";
import { Otter } from "./Otter";
import { Icon } from "./icons";
import { QuickOperation } from "./WorkTools";
import type { Health, Project, ProjectInfo } from "./types";

type Reminder = {
  id: string;
  title: string;
  kind: string;
  dueAt: number;
  status: string;
  createdAt: number;
};
type Todo = { id: string; title: string; done: boolean };
type State = {
  reminders: Reminder[];
  focus: Reminder | null;
  todos: Todo[];
};

const api = window.otter;

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function greeting(hour: number) {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}
// "15:30", "明天 09:00" or "11月2日 09:00".
function when(ms: number) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}
function left(ms: number, now: number) {
  const minutes = Math.round((ms - now) / 60000);
  if (minutes < 1) return "马上";
  if (minutes < 60) return `还有 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `还有 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
}
function mmss(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

// 今天: what matters now, at a glance. One line to ask for anything, a few cards
// for focus, reminders and todos, and the project and report you are likely to
// pick up next. Anything typed in the ask bar goes to chat, which already knows
// how to turn "1 小时后提醒我喝水" into a confirmed reminder.
export function TodayPane({
  health,
  handoffPending,
  report,
  onAsk,
  onOpenProject,
  onOpenHandoff,
}: {
  health: Health | null;
  handoffPending: number;
  report: { card: ReactNode; archive: ReactNode };
  onAsk: (text: string) => void;
  onOpenProject: (id?: string) => void;
  onOpenHandoff: () => void;
}) {
  const [state, setState] = useState<State>({
    reminders: [],
    focus: null,
    todos: [],
  });
  const [now, setNow] = useState(Date.now());
  const [nickname, setNickname] = useState("");
  const [project, setProject] = useState<{
    id: string;
    name: string;
    next: string;
  } | null>(null);
  const [ask, setAsk] = useState("");
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [todo, setTodo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reminderInput = useRef<HTMLInputElement>(null);
  const todoInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setState(await api.action<State>("assistant.get"));
  }
  useEffect(() => {
    let alive = true;
    const off = api.subscribe((e) => {
      if (e.type === "assistant.changed") setState(e.data);
    });
    void api
      .action<State>("assistant.get")
      .then((v) => alive && setState(v))
      .catch((e) => alive && setError(message(e)));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, []);
  // The name you gave the otter, and the project you touched last.
  useEffect(() => {
    if (!health) return;
    let alive = true;
    void api
      .call<{ settings: { nickname: string } }>("memory.get")
      .then((m) => alive && setNickname(m.settings.nickname.trim()))
      .catch(() => {});
    void api
      .call<ProjectInfo[]>("projects.list")
      .then(async (rows) => {
        const latest = rows
          .filter((p) => !p.archived)
          .sort((a, b) => b.updated - a.updated)[0];
        if (!latest) return alive && setProject(null);
        const full = await api.call<Project>("projects.get", {
          project_id: latest.id,
        });
        const snapshot = full.snapshots[full.snapshots.length - 1];
        const next = snapshot?.items.find((i) => i.kind === "next")?.content;
        if (alive)
          setProject({ id: latest.id, name: latest.name, next: next || "" });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [health]);

  async function act(name: string, value?: unknown) {
    setBusy(true);
    setError("");
    try {
      await api.action(name, value);
      await refresh();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function startFocus(length: number) {
    return act("assistant.create", {
      title: "专注结束，起来休息一下",
      dueAt: Date.now() + length * 60000,
      kind: "focus",
      requestId: crypto.randomUUID(),
    });
  }
  async function addReminder() {
    const ok = await act("assistant.create", {
      title,
      dueAt: Date.now() + minutes * 60000,
      kind: "reminder",
      requestId: crypto.randomUUID(),
    });
    if (ok) {
      setTitle("");
      setAdding(false);
    }
  }

  const active = state.reminders
    .filter((r) => ["pending", "due"].includes(r.status) && r.kind !== "focus")
    .sort((a, b) =>
      a.status === b.status ? a.dueAt - b.dueAt : a.status === "due" ? -1 : 1,
    );
  const due = active.filter((r) => r.status === "due");
  const upcoming = active.filter((r) => r.status === "pending");
  const todos = state.todos || [];
  const open = todos.filter((t) => !t.done).length;
  const summary =
    [
      due.length ? `有 ${due.length} 个提醒到时间了` : "",
      !due.length && upcoming[0]
        ? `${when(upcoming[0].dueAt)} 我会提醒你${upcoming[0].title}`
        : "",
      open ? `还有 ${open} 件待办` : todos.length ? "待办都做完了" : "",
    ]
      .filter(Boolean)
      .join("，") || "今天还没有安排，想做什么就跟我说";
  const remaining = state.focus
    ? Math.max(0, Math.ceil((state.focus.dueAt - now) / 1000))
    : focusMinutes * 60;
  const progress = state.focus
    ? 1 -
      remaining /
        Math.max(1, (state.focus.dueAt - state.focus.createdAt) / 1000)
    : 0;

  return (
    <section className="today" aria-label="今天">
      <header className="today-hello">
        <span className="today-otter" aria-hidden="true">
          <Otter mood={state.focus ? "working" : "waving"} size={128} />
        </span>
        <div>
          <h1>
            {greeting(new Date(now).getHours())}
            {nickname ? `，${nickname}` : ""}
          </h1>
          <p>{summary}。</p>
        </div>
      </header>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <form
        className="ask-bar"
        onSubmit={(e) => {
          e.preventDefault();
          const text = ask.trim();
          if (!text) return;
          onAsk(text);
          setAsk("");
        }}
      >
        <input
          aria-label="跟水獭说"
          placeholder="跟水獭说点什么，比如“1 小时后提醒我喝水”"
          maxLength={6000}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
        />
        <button
          type="submit"
          className="ask-send"
          aria-label="发给水獭"
          disabled={!ask.trim()}
        >
          <Icon name="send" />
        </button>
      </form>
      <div className="today-chips">
        {!state.focus && (
          <button disabled={busy} onClick={() => startFocus(25)}>
            专注 25 分钟
          </button>
        )}
        <button
          onClick={() => {
            setAdding(true);
            requestAnimationFrame(() => reminderInput.current?.focus());
          }}
        >
          提醒我…
        </button>
        <button onClick={() => todoInput.current?.focus()}>加一件待办</button>
        {project && (
          <button onClick={() => onOpenProject(project.id)}>
            继续“{project.name}”
          </button>
        )}
      </div>

      {handoffPending > 0 && (
        <section className="today-card today-notice" aria-label="待批准">
          <span className="card-icon">
            <Icon name="handoff" />
          </span>
          <div>
            <strong>有 {handoffPending} 个 AI 工具在等你批准</strong>
            <small>它们想读取项目进度，看过内容再决定。</small>
          </div>
          <button className="primary" onClick={onOpenHandoff}>
            去看看
          </button>
        </section>
      )}

      <div className="today-grid">
        <section
          className={`today-card focus-card${state.focus ? " running" : ""}`}
          aria-label="专注"
        >
          <h2>{state.focus ? "正在专注" : "专注"}</h2>
          <div
            className="focus-ring"
            style={{ "--p": progress } as React.CSSProperties}
          >
            <b>{mmss(remaining)}</b>
          </div>
          {state.focus ? (
            <button
              disabled={busy}
              onClick={() =>
                act("assistant.change", {
                  id: state.focus!.id,
                  status: "cancelled",
                })
              }
            >
              结束专注
            </button>
          ) : (
            <>
              <div className="segmented" role="group" aria-label="专注时长">
                {[15, 25, 50].map((m) => (
                  <button
                    key={m}
                    aria-pressed={focusMinutes === m}
                    onClick={() => setFocusMinutes(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <button
                className="primary"
                disabled={busy}
                onClick={() => startFocus(focusMinutes)}
              >
                开始 {focusMinutes} 分钟专注
              </button>
            </>
          )}
        </section>

        <section className="today-card reminder-card" aria-label="提醒">
          <div className="card-head">
            <h2>提醒</h2>
            <button className="link" onClick={() => setAdding((v) => !v)}>
              {adding ? "收起" : "＋ 新提醒"}
            </button>
          </div>
          {adding ? (
            <form
              className="quick-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim()) void addReminder();
              }}
            >
              <input
                ref={reminderInput}
                aria-label="提醒内容"
                placeholder="提醒我做什么"
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <div className="segmented" role="group" aria-label="多久以后">
                {[5, 15, 30, 60].map((m) => (
                  <button
                    type="button"
                    key={m}
                    aria-pressed={minutes === m}
                    onClick={() => setMinutes(m)}
                  >
                    {m < 60 ? `${m} 分` : "1 小时"}
                  </button>
                ))}
              </div>
              <button
                className="primary"
                type="submit"
                disabled={busy || !title.trim()}
              >
                创建提醒
              </button>
            </form>
          ) : active.length === 0 ? (
            <p className="card-empty">
              没有提醒。想到什么，点“新提醒”或者直接跟我说。
            </p>
          ) : (
            <ul className="reminder-rows">
              {active.slice(0, 4).map((r) => (
                <li key={r.id} className={r.status === "due" ? "due" : ""}>
                  <b>{r.status === "due" ? "到了" : when(r.dueAt)}</b>
                  <span>
                    {r.title}
                    <small>
                      {r.status === "due" ? "到时间了" : left(r.dueAt, now)}
                    </small>
                  </span>
                  <button
                    className={r.status === "due" ? "primary" : "ghost"}
                    disabled={busy}
                    aria-label={
                      r.status === "due" ? "知道了" : `取消“${r.title}”`
                    }
                    onClick={() =>
                      act("assistant.change", {
                        id: r.id,
                        status: r.status === "due" ? "done" : "cancelled",
                      })
                    }
                  >
                    {r.status === "due" ? "知道了" : "×"}
                  </button>
                </li>
              ))}
              {active.length > 4 && (
                <li className="more">还有 {active.length - 4} 个</li>
              )}
            </ul>
          )}
        </section>

        <section className="today-card todo-card" aria-label="待办">
          <div className="card-head">
            <h2>待办</h2>
            {todos.length > 0 && (
              <span>
                {todos.length - open} / {todos.length}
              </span>
            )}
          </div>
          <ul className="todo-rows">
            {todos.map((item) => (
              <li key={item.id} className={item.done ? "done" : ""}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => act("assistant.todo-toggle", item.id)}
                  />
                  <span>{item.title}</span>
                </label>
                <button
                  className="ghost"
                  aria-label={`删除待办：${item.title}`}
                  onClick={() => act("assistant.todo-delete", item.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form
            className="todo-add"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                todo.trim() &&
                (await act("assistant.todo-add", { title: todo }))
              )
                setTodo("");
            }}
          >
            <input
              ref={todoInput}
              aria-label="新待办"
              placeholder="加一件事…"
              maxLength={200}
              value={todo}
              onChange={(e) => setTodo(e.target.value)}
            />
            <button
              type="submit"
              aria-label="添加待办"
              disabled={busy || !todo.trim()}
            >
              <Icon name="plus" />
            </button>
          </form>
        </section>
      </div>

      <div className="today-row">
        {project && (
          <section className="today-card project-card" aria-label="继续的项目">
            <span className="card-icon">
              <Icon name="projects" />
            </span>
            <div>
              <strong>{project.name}</strong>
              <small>
                {project.next ? `下一步：${project.next}` : "打开看看进度"}
              </small>
            </div>
            <button onClick={() => onOpenProject(project.id)}>继续</button>
          </section>
        )}
        {report.card}
      </div>
      {report.archive}

      <details className="today-more">
        <summary>打开网页或应用</summary>
        <QuickOperation />
      </details>
    </section>
  );
}
