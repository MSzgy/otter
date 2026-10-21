import { useEffect, useRef, useState } from "react";
import type { ProjectDraft, ProjectItem, ProjectSource } from "./types";
const api = window.otter;
export function ProjectCapture({
  projectId,
  sessionId,
  manual = false,
  handoffId,
  onSaved,
  onClose,
}: {
  projectId: string;
  sessionId?: string;
  manual?: boolean;
  handoffId?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<{ id: string; title: string }[]>([]);
  const [sourceSession, setSourceSession] = useState(sessionId || "");
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true),
    draftId = useRef("");
  const emptyItem = (): ProjectItem => ({
    id: crypto.randomUUID(),
    kind: "next",
    content: "",
    source_ids: [],
  });
  const fail = (e: unknown) =>
    setError(
      e instanceof Error
        ? e.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          )
        : String(e),
    );
  function adopt(value: ProjectDraft) {
    if (!alive.current) {
      void api.call("projects.dismiss", { draft_id: value.id });
      return;
    }
    draftId.current = value.id;
    setDraft(value);
    setItems(value.items.length ? value.items : [emptyItem()]);
  }
  useEffect(() => {
    alive.current = true;
    if (handoffId) {
      setBusy(true);
      void api
        .call<ProjectDraft>("projects.handoff-open", {
          handoff_id: handoffId,
          project_id: projectId,
        })
        .then(adopt)
        .catch(fail)
        .finally(() => setBusy(false));
    } else if (manual) {
      setBusy(true);
      void api
        .call<ProjectDraft>("projects.manual", { project_id: projectId })
        .then(adopt)
        .catch(fail)
        .finally(() => setBusy(false));
    } else if (!sessionId) {
      void api
        .call<{ id: string; title: string }[]>("chat.sessions")
        .then((rows) => {
          if (alive.current) {
            setSessions(rows);
            setSourceSession(rows[0]?.id || "");
          }
        })
        .catch(fail);
    }
    return () => {
      alive.current = false;
      if (draftId.current)
        void api
          .call("projects.dismiss", { draft_id: draftId.current })
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!sourceSession || manual) return;
    let current = true;
    setSources([]);
    setSelected([]);
    setBusy(true);
    void api
      .call<ProjectSource[]>("projects.sources", { session_id: sourceSession })
      .then((rows) => {
        if (current) {
          setSources(rows);
          setSelected(
            rows
              .filter((r) => !r.attachment)
              .slice(-6)
              .map((r) => r.id),
          );
        }
      })
      .catch((e) => {
        if (current) fail(e);
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [sourceSession]);
  async function summarize() {
    setBusy(true);
    setError("");
    try {
      adopt(
        await api.call<ProjectDraft>("projects.draft", {
          project_id: projectId,
          session_id: sourceSession,
          source_ids: selected,
        }),
      );
    } catch (e) {
      if (alive.current) fail(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await api.call("projects.commit", {
        draft_id: draft.id,
        items: items.filter((i) => i.content.trim()),
      });
      draftId.current = "";
      onSaved();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-capture" aria-label="保存项目进度">
      <div className="section-title">
        <h2>{draft ? "确认这次进度" : "选择整理来源"}</h2>
        <button disabled={busy && !!draft} onClick={onClose}>
          {busy && !draft ? "停止并关闭" : "取消"}
        </button>
      </div>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      {!draft && handoffId ? (
        <p className="muted">{busy ? "正在打开交接内容…" : ""}</p>
      ) : !draft ? (
        <>
          <p className="muted">
            仅将勾选的内容发送给当前模型。最近 30 条消息中，每条最多取 2000
            字；未发送的草稿不在这里。
          </p>
          {!sessionId && (
            <label>
              来源对话
              <select
                aria-label="快照来源对话"
                value={sourceSession}
                disabled={busy}
                onChange={(e) => setSourceSession(e.target.value)}
              >
                {sessions.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="project-sources">
            {sources.map((source) => (
              <article key={source.id}>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(source.id)}
                    onChange={(e) =>
                      setSelected((rows) =>
                        e.target.checked
                          ? [...rows, source.id]
                          : rows.filter((id) => id !== source.id),
                      )
                    }
                  />
                  {source.label} ·{" "}
                  {new Date(source.created * 1000).toLocaleString()}
                  {source.truncated ? " · 摘录" : ""}
                </label>
                <details>
                  <summary>查看来源内容</summary>
                  <p className="project-text">{source.content}</p>
                </details>
              </article>
            ))}
          </div>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || !selected.length}
              onClick={summarize}
            >
              {busy ? "正在整理…" : `整理已选内容（${selected.length}）`}
            </button>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  adopt(
                    await api.call<ProjectDraft>("projects.manual", {
                      project_id: projectId,
                    }),
                  );
                } catch (e) {
                  fail(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              改为手动记录
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            {handoffId
              ? "这些条目是 AI 工具的自述，Otter 没有核对。请逐条检查后再保存；草稿十分钟内有效，过期可从“AI 交接”重新打开。"
              : "检查事实是否准确，特别是“已完成”和“下一步”。确认前不会用于项目续接；草稿十分钟内有效。"}
          </p>
          {items.map((item, index) => (
            <article className="project-draft-item" key={item.id}>
              <div className="button-row">
                <select
                  aria-label={`进度类型 ${index + 1}`}
                  value={item.kind}
                  disabled={busy}
                  onChange={(e) =>
                    setItems((rows) =>
                      rows.map((r) =>
                        r.id === item.id
                          ? {
                              ...r,
                              kind: e.target.value as ProjectItem["kind"],
                            }
                          : r,
                      ),
                    )
                  }
                >
                  <option value="completed">已完成</option>
                  <option value="blocker">当前卡点</option>
                  <option value="next">下一步</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() =>
                    setItems((rows) => rows.filter((r) => r.id !== item.id))
                  }
                >
                  移除这条
                </button>
              </div>
              <textarea
                aria-label={`进度内容 ${index + 1}`}
                value={item.content}
                maxLength={item.kind === "next" ? 200 : 600}
                disabled={busy}
                onChange={(e) =>
                  setItems((rows) =>
                    rows.map((r) =>
                      r.id === item.id ? { ...r, content: e.target.value } : r,
                    ),
                  )
                }
              />
              {item.source_ids.length ? (
                <details>
                  <summary>查看依据</summary>
                  {item.source_ids.map((id) => {
                    const source = draft.sources.find((s) => s.id === id);
                    return (
                      source && (
                        <p key={id} className="project-text">
                          {source.label}：
                          {item.evidence?.find((e) => e.source_id === id)
                            ?.quote || source.content}
                        </p>
                      )
                    );
                  })}
                </details>
              ) : (
                <small>手动记录，由你确认。</small>
              )}
            </article>
          ))}
          <div className="button-row">
            <button
              disabled={busy || items.length >= 15}
              onClick={() => setItems((rows) => [...rows, emptyItem()])}
            >
              添加一条进度
            </button>
            <button
              className="primary"
              disabled={busy || !items.some((i) => i.content.trim())}
              onClick={save}
            >
              {busy ? "保存中…" : "确认保存快照"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
