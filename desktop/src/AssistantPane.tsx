import { useEffect, useState } from "react";
import "./types";
type Reminder = {
  id: string;
  title: string;
  kind: string;
  dueAt: number;
  status: string;
  createdAt: number;
};
type Work = {
  id: string;
  title: string;
  context: string;
  question: string;
  nextStep: string;
  createdAt: number;
};
type Todo = { id: string; title: string; done: boolean };
type State = {
  reminders: Reminder[];
  focus: Reminder | null;
  todos: Todo[];
  sessions: Work[];
};
export function AssistantPane() {
  const [state, setState] = useState<State>({
    reminders: [],
    focus: null,
    todos: [],
    sessions: [],
  });
  const [title, setTitle] = useState("");
  const [todo, setTodo] = useState("");
  const [operation, setOperation] = useState({ kind: "open_url", target: "" });
  const [proposal, setProposal] = useState<{
    id: string;
    label: string;
    description: string;
  } | null>(null);
  const [operationResult, setOperationResult] = useState("");
  async function prepareOperation() {
    try {
      setProposal(await window.otter.action("actions.prepare", operation));
      setOperationResult("");
    } catch (e) {
      setError(String(e));
    }
  }
  async function confirmOperation() {
    if (!proposal) return;
    try {
      const result = await window.otter.action<{ message: string }>(
        "actions.confirm",
        proposal.id,
      );
      setOperationResult(result.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setProposal(null);
    }
  }
  const [work, setWork] = useState({
    title: "",
    context: "",
    question: "",
    nextStep: "",
  });
  const [deleteWork, setDeleteWork] = useState<string | null>(null);
  async function captureScene() {
    try {
      const context = await window.otter.action<string>(
        "assistant.scene-preview",
      );
      setWork((w) => ({ ...w, context }));
    } catch (e) {
      setError(String(e));
    }
  }
  const [minutes, setMinutes] = useState(25);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const off = window.otter.subscribe((e) => {
      if (e.type === "assistant.changed") setState(e.data);
    });
    void window.otter
      .action<State>("assistant.get")
      .then((v) => {
        if (alive) setState(v);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, []);
  async function action(name: string, value?: unknown) {
    setBusy(true);
    setError("");
    try {
      await window.otter.action(name, value);
      setState(await window.otter.action<State>("assistant.get"));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(kind: string) {
    const ok = await action("assistant.create", {
      title: kind === "focus" ? "专注结束，起来休息一下" : title,
      dueAt: Date.now() + minutes * 60000,
      kind,
      requestId: crypto.randomUUID(),
    });
    if (ok && kind === "reminder") setTitle("");
  }
  const remaining = state.focus
    ? Math.max(0, Math.ceil((state.focus.dueAt - now) / 1000))
    : 0;
  const active = state.reminders.filter((r) =>
    ["pending", "due"].includes(r.status),
  );
  return (
    <section className="assistant-pane">
      <div className="heading">
        <p className="eyebrow">把小事交给我</p>
        <h1>留一点时间给自己。</h1>
        <p className="muted">本机提醒与专注计时，不需要模型或网络。</p>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <section className="focus-stage">
        <div>
          <h2>{state.focus ? "正在专注" : "专注一会儿"}</h2>
          <p>
            {state.focus
              ? "已暂停简报完成通知；明确设置的提醒仍然有效。"
              : "到时间后，我会提醒你休息。"}
          </p>
        </div>
        {state.focus ? (
          <>
            <strong className="focus-clock">
              {Math.floor(remaining / 60)
                .toString()
                .padStart(2, "0")}
              :{(remaining % 60).toString().padStart(2, "0")}
            </strong>
            <button
              disabled={busy}
              onClick={() =>
                action("assistant.change", {
                  id: state.focus!.id,
                  status: "cancelled",
                })
              }
            >
              结束专注
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={busy || minutes < 1 || minutes > 10080}
            onClick={() => create("focus")}
          >
            开始 {minutes} 分钟专注
          </button>
        )}
      </section>
      <section className="reminder-form">
        <label>
          多少分钟后
          <input
            type="number"
            aria-label="提醒分钟数"
            min={1}
            max={10080}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <div className="button-row">
          {[5, 25, 60].map((value) => (
            <button key={value} onClick={() => setMinutes(value)}>
              {value} 分钟
            </button>
          ))}
        </div>
        <label>
          提醒内容
          <input
            aria-label="提醒内容"
            maxLength={200}
            placeholder="例如：喝水、关火、参加会议"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !title.trim() || minutes < 1 || minutes > 10080}
          onClick={() => create("reminder")}
        >
          创建提醒
        </button>
      </section>
      <div className="section-title">
        <h2>提醒清单</h2>
        <button disabled={busy} onClick={() => action("assistant.clear")}>
          清理已完成记录
        </button>
      </div>
      {active.length === 0 ? (
        <div className="empty">
          <h3>暂时没有待办的提醒</h3>
          <p>创建后会在这里显示，到时间再提示你。</p>
        </div>
      ) : (
        <div className="reminder-list">
          {active.map((r) => (
            <article key={r.id} className={r.status === "due" ? "due" : ""}>
              <div>
                <strong>{r.title}</strong>
                <small>
                  {r.status === "due"
                    ? "已到时间，待确认"
                    : new Date(r.dueAt).toLocaleString()}
                  {r.kind === "focus" ? " · 专注计时" : ""}
                </small>
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  action("assistant.change", {
                    id: r.id,
                    status: r.status === "due" ? "done" : "cancelled",
                  })
                }
              >
                {r.status === "due" ? "知道了" : "取消"}
              </button>
            </article>
          ))}
        </div>
      )}
      <section className="assistant-section">
        <h2>本地待办</h2>
        <div className="button-row">
          <input
            aria-label="新待办"
            placeholder="接下来要做什么"
            maxLength={200}
            value={todo}
            onChange={(e) => setTodo(e.target.value)}
          />
          <button
            disabled={busy || !todo.trim()}
            onClick={async () => {
              if (await action("assistant.todo-add", { title: todo }))
                setTodo("");
            }}
          >
            添加待办
          </button>
        </div>
        <div className="todo-list">
          {(state.todos || []).map((item) => (
            <div key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => action("assistant.todo-toggle", item.id)}
                />
                <span
                  style={{
                    textDecoration: item.done ? "line-through" : "none",
                  }}
                >
                  {item.title}
                </span>
              </label>
              <button onClick={() => action("assistant.todo-delete", item.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="assistant-section">
        <h2>保存工作现场</h2>
        <p className="muted">
          保存你选择的背景、问题和下一步。恢复时先进入聊天预览，不会自动发送。
        </p>
        <div className="work-form">
          {(
            [
              { key: "title", label: "现场名称", max: 160 },
              { key: "context", label: "页面与工作背景", max: 18000 },
              { key: "question", label: "当前问题", max: 2000 },
              { key: "nextStep", label: "下一步", max: 2000 },
            ] as const
          ).map((field) => (
            <label key={field.key}>
              {field.label}
              <textarea
                aria-label={field.label}
                maxLength={field.max}
                value={work[field.key]}
                onChange={(e) =>
                  setWork((w) => ({ ...w, [field.key]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
        <div className="button-row">
          <button onClick={captureScene}>带入感知到的场景</button>
          <button
            className="primary"
            disabled={busy || !work.title.trim() || !work.nextStep.trim()}
            onClick={async () => {
              if (await action("assistant.work-save", work))
                setWork({ title: "", context: "", question: "", nextStep: "" });
            }}
          >
            保存工作现场
          </button>
        </div>
        <div className="saved-work">
          {(state.sessions || []).map((item) => (
            <article key={item.id}>
              <h3>{item.title}</h3>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
              <p>下一步：{item.nextStep}</p>
              <div className="button-row">
                <button
                  onClick={() =>
                    window.otter
                      .action("assistant.work-restore", item.id)
                      .catch((e) => setError(e.message))
                  }
                >
                  在聊天中继续
                </button>
                <button onClick={() => setDeleteWork(item.id)}>删除现场</button>
              </div>
              {deleteWork === item.id && (
                <div>
                  确认删除这份本地记录？
                  <button
                    onClick={() => {
                      void action("assistant.work-delete", item.id);
                      setDeleteWork(null);
                    }}
                  >
                    确认删除现场
                  </button>
                  <button onClick={() => setDeleteWork(null)}>保留</button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      <section className="assistant-section">
        <h2>简单操作</h2>
        <p className="muted">
          先预览具体目标，确认后才执行。不运行任意终端命令。
        </p>
        <div className="operation-form">
          <select
            aria-label="操作类型"
            value={operation.kind}
            onChange={(e) => {
              setOperation((o) => ({ ...o, kind: e.target.value }));
              setProposal(null);
            }}
          >
            <option value="open_url">打开链接</option>
            <option value="open_app">打开应用</option>
          </select>
          <input
            aria-label="操作目标"
            value={operation.target}
            onChange={(e) => {
              setOperation((o) => ({ ...o, target: e.target.value }));
              setProposal(null);
            }}
            placeholder={
              operation.kind === "open_url"
                ? "https://example.com"
                : "com.apple.calculator"
            }
          />
          <button
            disabled={!operation.target.trim()}
            onClick={prepareOperation}
          >
            预览操作
          </button>
        </div>
        {proposal && (
          <div className="context-preview" aria-label="操作确认">
            <strong>{proposal.label}</strong>
            <p>{proposal.description}</p>
            <div className="button-row">
              <button className="primary" onClick={confirmOperation}>
                确认执行
              </button>
              <button
                onClick={() => {
                  void window.otter.action("actions.cancel", proposal.id);
                  setProposal(null);
                }}
              >
                取消操作
              </button>
            </div>
          </div>
        )}
        {operationResult && <p role="status">{operationResult}</p>}
      </section>
      <p className="assistant-note">
        提醒会保存，重启后恢复。Mac 睡眠或 Otter
        退出期间不能准点提示；恢复后会合并提示错过的提醒。关闭主面板仍会继续计时。
      </p>
    </section>
  );
}
