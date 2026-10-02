import { useEffect, useRef, useState } from "react";
import "./types";
type Entry = {
  id: string;
  title: string;
  content: string;
  category: string;
  updated: number;
};
type Settings = { enabled: boolean; nickname: string; tone: string };
type State = { entries: Entry[]; settings: Settings; limit: number };
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
  const [draft, setDraft] = useState(blank);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const form = useRef<HTMLElement>(null);
  const edited = useRef(false);
  async function reload() {
    const value = await api.call<State>("memory.get");
    setState(value);
    // Chat can save a memory while this page is open; keep unsaved edits.
    if (!edited.current) setSettings(value.settings);
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
      if (method === "memory.configure" || method === "memory.clear")
        edited.current = false;
      await reload();
      setNotice(done);
      setConfirm(null);
      if (method !== "memory.configure") setDraft(blank);
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
  return (
    <section className="memory-pane">
      <div className="heading">
        <div>
          <p className="eyebrow">一点了解，长久陪伴</p>
          <h1>水獭记住了什么。</h1>
          <p className="muted">
            只保存你明确要求记住的内容。网页、窗口附件和模型回复不会自动成为记忆。
          </p>
        </div>
      </div>
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
      <section className="settings-section">
        <h2>我们的相处方式</h2>
        <label>
          希望水獭怎么称呼你
          <input
            aria-label="你的称呼"
            value={settings.nickname}
            maxLength={40}
            onChange={(e) => changeSettings({ nickname: e.target.value })}
            placeholder="例如：小杨"
          />
        </label>
        <label>
          说话风格
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
        <label className="check">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => changeSettings({ enabled: e.target.checked })}
          />
          启用长期记忆
        </label>
        <p className="muted">
          称呼和风格始终生效。关闭长期记忆后保留已有条目，但聊天不再引用或保存记忆；聊天页也可以只关闭本轮记忆。
        </p>
        <div className="button-row">
          <button
            className="primary"
            disabled={busy || !state}
            onClick={() =>
              action("memory.configure", settings, "相处方式已保存。")
            }
          >
            保存相处方式
          </button>
        </div>
      </section>
      <section className="settings-section" ref={form}>
        <h2>{draft.id ? "修改这条记忆" : "添加一条记忆"}</h2>
        <label>
          分类
          <select
            aria-label="记忆分类"
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          >
            {Object.entries(categories).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input
            aria-label="记忆标题"
            maxLength={80}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="例如：桌面机器人项目"
          />
        </label>
        <label>
          内容
          <textarea
            aria-label="记忆内容"
            maxLength={1200}
            rows={4}
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="例如：目前先做纯软件桌面助手，之后再接屏幕和舵机。"
          />
        </label>
        <div className="button-row">
          <button
            className="primary"
            disabled={
              busy || !state || !draft.title.trim() || !draft.content.trim()
            }
            onClick={() =>
              action(
                "memory.save",
                {
                  id: draft.id || undefined,
                  title: draft.title,
                  content: draft.content,
                  category: draft.category,
                },
                draft.id ? "修改已保存。" : "记忆已保存。",
              )
            }
          >
            {draft.id ? "保存修改" : "保存记忆"}
          </button>
          {draft.id && (
            <button onClick={() => setDraft(blank)}>取消修改</button>
          )}
        </div>
        <p className="muted">
          聊天中也可以说“记住：我喜欢简洁的回答”，只保存这句话里明确写出的内容；说“忘掉刚才那条”可以撤回。
        </p>
      </section>
      <div className="section-title">
        <h2>
          已保存的记忆 · {state?.entries.length || 0}/{state?.limit || 300}
        </h2>
        <button
          disabled={busy || !state || !state.entries.length}
          onClick={() => setConfirm("all")}
        >
          清空全部记忆
        </button>
      </div>
      <input
        className="memory-search"
        aria-label="搜索记忆"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索标题或内容"
      />
      {confirm && (
        <div className="alert" role="alert">
          <p>
            {confirm === "all"
              ? "清空所有长期记忆，并重置称呼和说话风格？聊天记录仍会保留；如需彻底移除相关内容，请另外删除对应对话。"
              : "删除这条长期记忆？对应聊天记录仍会保留。"}
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
      {state && entries.length === 0 && (
        <p className="muted">
          {needle
            ? "没有匹配的记忆。"
            : "还没有记忆。从一条偏好或项目进度开始吧。"}
        </p>
      )}
      <div className="memory-list">
        {entries.map((e) => (
          <article
            key={e.id}
            className={draft.id === e.id ? "editing" : ""}
            aria-label={`记忆：${e.title}`}
          >
            <small>
              {categories[e.category]} ·{" "}
              {new Date(e.updated * 1000).toLocaleDateString()}
            </small>
            <h3>{e.title}</h3>
            <p>{e.content}</p>
            <div className="button-row">
              <button
                disabled={busy}
                onClick={() => {
                  setDraft(e);
                  setNotice("");
                  form.current?.scrollIntoView({ block: "start" });
                }}
              >
                修改
              </button>
              <button disabled={busy} onClick={() => setConfirm(e.id)}>
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      <p className="muted">
        记忆保存在当前工作空间的本机数据库，切换工作空间后各自独立。使用云端模型聊天时，称呼、风格和本轮选中的相关记忆会随消息发送给你配置的模型。删除记忆不会撤回已发送的内容或原有聊天记录。
      </p>
    </section>
  );
}
