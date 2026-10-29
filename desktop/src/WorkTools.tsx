import { useState } from "react";
import "./types";

type Work = {
  id: string;
  title: string;
  context: string;
  question: string;
  nextStep: string;
  createdAt: number;
};

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// Saved work scenes: background, question and next step, picked up later in chat.
export function WorkScenes({
  sessions,
  onChanged,
}: {
  sessions: Work[];
  onChanged: () => void;
}) {
  const empty = { title: "", context: "", question: "", nextStep: "" };
  const [work, setWork] = useState(empty);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(name: string, value?: unknown) {
    setBusy(true);
    setError("");
    try {
      await window.otter.action(name, value);
      onChanged();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tool-section" aria-label="保存工作现场">
      <h3>保存工作现场</h3>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
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
        <button
          onClick={async () => {
            try {
              const context = await window.otter.action<string>(
                "assistant.scene-preview",
              );
              setWork((w) => ({ ...w, context }));
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          带入感知到的场景
        </button>
        <button
          className="primary"
          disabled={busy || !work.title.trim() || !work.nextStep.trim()}
          onClick={async () => {
            if (await act("assistant.work-save", work)) setWork(empty);
          }}
        >
          保存工作现场
        </button>
      </div>
      <div className="saved-work">
        {sessions.map((item) => (
          <article key={item.id}>
            <h3>{item.title}</h3>
            <small>{new Date(item.createdAt).toLocaleString()}</small>
            <p>下一步：{item.nextStep}</p>
            <div className="button-row">
              <button
                onClick={() =>
                  window.otter
                    .action("assistant.work-restore", item.id)
                    .catch((e) => setError(message(e)))
                }
              >
                在聊天中继续
              </button>
              <button onClick={() => setDeleting(item.id)}>删除现场</button>
            </div>
            {deleting === item.id && (
              <div>
                确认删除这份本地记录？
                <button
                  onClick={() => {
                    void act("assistant.work-delete", item.id);
                    setDeleting(null);
                  }}
                >
                  确认删除现场
                </button>
                <button onClick={() => setDeleting(null)}>保留</button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

// Open a link or an app, previewed first; never an arbitrary command.
export function QuickOperation() {
  const [operation, setOperation] = useState({ kind: "open_url", target: "" });
  const [proposal, setProposal] = useState<{
    id: string;
    label: string;
    description: string;
  } | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  return (
    <section className="tool-section" aria-label="简单操作">
      <h3>打开网页或应用</h3>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
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
          onClick={async () => {
            setError("");
            try {
              setProposal(
                await window.otter.action("actions.prepare", operation),
              );
              setResult("");
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          预览操作
        </button>
      </div>
      {proposal && (
        <div className="context-preview" aria-label="操作确认">
          <strong>{proposal.label}</strong>
          <p>{proposal.description}</p>
          <div className="button-row">
            <button
              className="primary"
              onClick={async () => {
                try {
                  const done = await window.otter.action<{ message: string }>(
                    "actions.confirm",
                    proposal.id,
                  );
                  setResult(done.message);
                } catch (e) {
                  setError(message(e));
                } finally {
                  setProposal(null);
                }
              }}
            >
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
      {result && <p role="status">{result}</p>}
    </section>
  );
}
