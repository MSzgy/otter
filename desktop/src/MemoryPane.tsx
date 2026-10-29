import { useEffect, useRef, useState } from "react";
import "./types";
import { MemorySuggestions } from "./MemorySuggestions";
type Entry = {
  id: string;
  title: string;
  content: string;
  category: string;
  updated: number;
};
type Settings = { enabled: boolean; nickname: string; tone: string };
type AISettings = { suggestions: boolean; semantic: boolean };
type State = {
  entries: Entry[];
  settings: Settings;
  limit: number;
  ai: AISettings;
};
const api = window.otter;
const categories: Record<string, string> = {
  profile: "关于你",
  preference: "偏好",
  project: "项目进度",
  fact: "其他",
};
const blank = { id: "", title: "", content: "", category: "fact" };
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);
}
export function MemoryPane({
  focus,
  onFocused,
}: {
  focus: string | null;
  onFocused: () => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [settings, setSettings] = useState<Settings>({
    enabled: true,
    nickname: "",
    tone: "warm",
  });
  const [ai, setAI] = useState<AISettings>({
    suggestions: true,
    semantic: true,
  });
  const aiEdited = useRef(false);
  const [draft, setDraft] = useState(blank);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const edited = useRef(false);
  async function reload() {
    const value = await api.call<State>("memory.get");
    setState(value);
    // Chat can save a memory while this page is open; keep unsaved edits.
    if (!edited.current) setSettings(value.settings);
    if (!aiEdited.current) setAI(value.ai);
    setError("");
    return value;
  }
  useEffect(() => {
    let alive = true;
    const load = () =>
      reload().catch((e) => {
        if (alive) setError(message(e));
      });
    const off = api.subscribe((event) => {
      if (
        event.type === "memory.changed" ||
        (event.type === "connection" && event.data.status === "online")
      )
        void load();
    });
    void load();
    return () => {
      alive = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (!focus || !state) return;
    const entry = state.entries.find((e) => e.id === focus);
    if (entry) {
      setDraft(entry);
      setNotice("");
      form.current?.scrollIntoView({ block: "start" });
    } else setNotice("这条记忆已经不在了，可能已被删除。");
    onFocused();
  }, [focus, state]);
  async function action(
    method: string,
    params: Record<string, unknown>,
    done: string,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.call(method, params);
      if (method === "memory.ai-configure") aiEdited.current = false;
      if (method === "memory.configure" || method === "memory.clear")
        edited.current = false;
      await reload();
      setNotice(done);
      setConfirm(null);
      if (method !== "memory.configure") setDraft(blank);
      if (method === "memory.save") setAdding(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function changeSettings(value: Partial<Settings>) {
    edited.current = true;
    setSettings((current) => ({ ...current, ...value }));
  }
  const needle = query.trim().toLowerCase();
  const entries =
    state?.entries.filter((e) =>
      (e.title + e.content).toLowerCase().includes(needle),
    ) || [];
  const editing = adding || !!draft.id;
  return (
    <div className="memory-pane">
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="model-success" role="status">
          {notice}
        </p>
      )}
      {!state && !error && <p className="muted">正在打开记忆…</p>}
      <MemorySuggestions />
      <div className="otter-cols">
        <section className="today-card memory-card" aria-label="它记得">
          <div className="card-head">
            <h2>它记得</h2>
            {state && (
              <span>
                {state.entries.length} / {state.limit}
              </span>
            )}
          </div>
          {state && state.entries.length > 6 && (
            <input
              className="memory-search"
              aria-label="搜索记忆"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题或内容"
            />
          )}
          {state && entries.length === 0 ? (
            <p className="card-empty">
              {needle
                ? "没有匹配的记忆。"
                : "还没有记忆。聊天时说“记住：……”，或者点下面告诉它。"}
            </p>
          ) : (
            <div className="memory-list">
              {entries.map((e) => (
                <article
                  key={e.id}
                  className={draft.id === e.id ? "editing" : ""}
                  aria-label={`记忆：${e.title}`}
                >
                  <div>
                    <b>{e.title}</b>
                    <small>
                      {categories[e.category]} · {e.content}
                    </small>
                  </div>
                  <span className="row-actions">
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        setDraft(e);
                        setNotice("");
                        requestAnimationFrame(() =>
                          form.current?.scrollIntoView({ block: "nearest" }),
                        );
                      }}
                    >
                      修改
                    </button>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => setConfirm(e.id)}
                    >
                      删除
                    </button>
                  </span>
                </article>
              ))}
            </div>
          )}
          {confirm && (
            <div className="alert" role="alert">
              <p>
                {confirm === "all"
                  ? "清空所有记忆，并重置称呼和说话风格？聊天记录会保留。"
                  : "删除这条记忆？对应的聊天记录会保留。"}
              </p>
              <div className="button-row">
                <button
                  disabled={busy}
                  onClick={() =>
                    confirm === "all"
                      ? action(
                          "memory.clear",
                          { confirm: true },
                          "长期记忆和个性设置已清空。",
                        )
                      : action("memory.delete", { id: confirm }, "记忆已删除。")
                  }
                >
                  确认删除记忆
                </button>
                <button disabled={busy} onClick={() => setConfirm(null)}>
                  取消
                </button>
              </div>
            </div>
          )}
          {editing ? (
            <form
              ref={form}
              className="memory-form"
              onSubmit={(ev) => {
                ev.preventDefault();
                void action(
                  "memory.save",
                  {
                    id: draft.id || undefined,
                    title: draft.title,
                    content: draft.content,
                    category: draft.category,
                  },
                  draft.id ? "修改已保存。" : "记忆已保存。",
                );
              }}
            >
              <h3>{draft.id ? "修改这条记忆" : "告诉它一件事"}</h3>
              <div className="memory-form-row">
                <select
                  aria-label="记忆分类"
                  value={draft.category}
                  onChange={(e) =>
                    setDraft({ ...draft, category: e.target.value })
                  }
                >
                  {Object.entries(categories).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="记忆标题"
                  maxLength={80}
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                  placeholder="标题，比如：回答风格"
                />
              </div>
              <textarea
                aria-label="记忆内容"
                maxLength={1200}
                rows={3}
                value={draft.content}
                onChange={(e) =>
                  setDraft({ ...draft, content: e.target.value })
                }
                placeholder="比如：喜欢简洁的回答"
              />
              <div className="button-row">
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    busy ||
                    !state ||
                    !draft.title.trim() ||
                    !draft.content.trim()
                  }
                >
                  {draft.id ? "保存修改" : "保存记忆"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(blank);
                    setAdding(false);
                  }}
                >
                  {draft.id ? "取消修改" : "取消"}
                </button>
              </div>
            </form>
          ) : (
            <div className="card-foot">
              <button className="link" onClick={() => setAdding(true)}>
                ＋ 告诉它一件事
              </button>
              {!!state?.entries.length && (
                <button className="link" onClick={() => setConfirm("all")}>
                  清空全部记忆
                </button>
              )}
            </div>
          )}
        </section>

        <section className="today-card personality-card" aria-label="相处方式">
          <h2>相处方式</h2>
          <label className="setting-line">
            <span>怎么称呼你</span>
            <input
              aria-label="你的称呼"
              value={settings.nickname}
              maxLength={40}
              onChange={(e) => changeSettings({ nickname: e.target.value })}
              placeholder="比如：小杨"
            />
          </label>
          <label className="setting-line">
            <span>说话风格</span>
            <select
              aria-label="说话风格"
              value={settings.tone}
              onChange={(e) => changeSettings({ tone: e.target.value })}
            >
              <option value="warm">自然温柔</option>
              <option value="concise">简洁直接</option>
              <option value="playful">轻松活泼</option>
            </select>
          </label>
          <label className="setting-line">
            <span>
              长期记忆
              <small>关掉后保留已有记忆，但聊天不再用它</small>
            </span>
            <input
              type="checkbox"
              className="toggle"
              aria-label="启用长期记忆"
              checked={settings.enabled}
              onChange={(e) => changeSettings({ enabled: e.target.checked })}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !state}
            onClick={() =>
              action("memory.configure", settings, "相处方式已保存。")
            }
          >
            保存相处方式
          </button>
          <h3>更聪明的记忆</h3>
          <label className="setting-line">
            <span>从聊天里提出记忆建议</span>
            <input
              type="checkbox"
              className="toggle"
              aria-label="从聊天建议记忆"
              checked={ai.suggestions}
              onChange={(e) => {
                aiEdited.current = true;
                setAI({ ...ai, suggestions: e.target.checked });
              }}
            />
          </label>
          <label className="setting-line">
            <span>按意思查找相关记忆</span>
            <input
              type="checkbox"
              className="toggle"
              aria-label="按意思检索记忆"
              checked={ai.semantic}
              onChange={(e) => {
                aiEdited.current = true;
                setAI({ ...ai, semantic: e.target.checked });
              }}
            />
          </label>
          <small className="card-note">
            会额外调用你配置的模型；离线演示只用关键词。
          </small>
          <button
            disabled={busy || !state}
            onClick={() =>
              action("memory.ai-configure", ai, "增强记忆设置已保存。")
            }
          >
            保存增强设置
          </button>
        </section>
      </div>
      <p className="otter-tip">
        记忆只存在这台电脑的当前工作空间里；用云端模型聊天时，相关记忆会随消息发给你配置的模型。
      </p>
    </div>
  );
}
