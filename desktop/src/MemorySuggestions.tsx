import { useEffect, useState } from "react";
import "./types";
type Candidate = {
  id: string;
  title: string;
  content: string;
  category: string;
  evidence: string;
};
const labels: Record<string, string> = {
  profile: "关于你",
  preference: "偏好",
  project: "项目进度",
  fact: "其他",
};
function CandidateCard({
  candidate,
  onDone,
}: {
  candidate: Candidate;
  onDone: (accepted: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState(candidate);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      await window.otter.call(
        accept ? "memory.accept" : "memory.dismiss",
        accept ? { ...draft } : { id: candidate.id },
      );
      await onDone(accept);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="memory-candidate"
      aria-label={`待确认记忆：${candidate.title}`}
    >
      <small>建议 · {labels[draft.category]}</small>
      {editing ? (
        <>
          <label>
            标题
            <input
              aria-label="建议标题"
              value={draft.title}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            内容
            <textarea
              aria-label="建议内容"
              value={draft.content}
              maxLength={1200}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          <label>
            分类
            <select
              aria-label="建议分类"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            >
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          <h3>{draft.title}</h3>
          <p>{draft.content}</p>
        </>
      )}
      <details>
        <summary>来自你说的这句话</summary>
        <blockquote>{candidate.evidence}</blockquote>
      </details>
      {error && <p role="alert">{error}</p>}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !draft.title.trim() || !draft.content.trim()}
          onClick={() => decide(true)}
        >
          确认记住
        </button>
        <button disabled={busy} onClick={() => setEditing(!editing)}>
          {editing ? "收起编辑" : "修改后确认"}
        </button>
        <button disabled={busy} onClick={() => decide(false)}>
          不记住
        </button>
      </div>
    </article>
  );
}
export function MemorySuggestions({ sessionId }: { sessionId?: string }) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () =>
      window.otter
        .call<Candidate[]>(
          "memory.candidates",
          sessionId ? { session_id: sessionId } : {},
        )
        .then((v) => {
          if (alive) setItems(v);
        })
        .catch(() => {});
    const off = window.otter.subscribe((e) => {
      if (e.type === "memory.changed") {
        setNotice("");
        void load();
      }
      if (
        e.type === "memory.suggestion-status" &&
        e.data.session_id === sessionId
      )
        setNotice(e.data.message);
    });
    void load();
    return () => {
      alive = false;
      off();
    };
  }, [sessionId]);
  async function reload(accepted: boolean) {
    setItems(
      await window.otter.call<Candidate[]>(
        "memory.candidates",
        sessionId ? { session_id: sessionId } : {},
      ),
    );
    setNotice(
      accepted
        ? "已确认并保存为长期记忆。"
        : "这条建议已忽略，没有写入长期记忆。",
    );
  }
  if (!items.length && !notice) return null;
  return (
    <section className="memory-suggestions" aria-label="待确认的记忆建议">
      <div className="section-title">
        <h2>这件事值得记住吗？</h2>
      </div>
      <p className="muted">
        水獭提出的候选，确认前不会用于聊天。可以修改或拒绝；未处理的建议保留 7
        天。
      </p>
      {notice && <p role="status">{notice}</p>}
      {items.map((c) => (
        <CandidateCard key={c.id} candidate={c} onDone={reload} />
      ))}
    </section>
  );
}
