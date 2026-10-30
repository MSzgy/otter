import { useEffect, useState } from "react";
import "./types";

type Host = {
  id: string;
  source: "otter" | "config";
  name: string;
  host: string;
  port: number;
  user: string;
  auth?: "key" | "agent" | "password";
  keyPath?: string;
  jump?: string;
  note?: string;
  hasPassword?: boolean;
  alias?: string;
};
type State = { hosts: Host[]; configFile: string };
type Draft = {
  id: string | null;
  name: string;
  host: string;
  port: string;
  user: string;
  auth: "key" | "agent" | "password";
  keyPath: string;
  jump: string;
  note: string;
  password: string;
};

const api = window.otter;
const empty: Draft = {
  id: null,
  name: "",
  host: "",
  port: "22",
  user: "",
  auth: "key",
  keyPath: "~/.ssh/id_ed25519",
  jump: "",
  note: "",
  password: "",
};
const where = (h: Host) =>
  `${h.user ? h.user + "@" : ""}${h.host}${h.port !== 22 ? ":" + h.port : ""}`;
const short = (p = "") => p.replace(/^\/Users\/[^/]+/, "~");
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);
}
function authText(h: Host) {
  if (h.source === "config") return "来自 ~/.ssh/config";
  if (h.auth === "key") return `密钥 ${short(h.keyPath)}`;
  if (h.auth === "agent") return "ssh-agent";
  return h.hasPassword ? "密码 · 在钥匙串里" : "密码 · 还没填";
}

// SSH 服务器: saved logins and ~/.ssh/config hosts, with connect and test.
export function SshPane() {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [results, setResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function run<T>(name: string, value?: unknown) {
    setError("");
    try {
      return await api.action<T>(name, value);
    } catch (e) {
      setError(message(e));
      return null;
    }
  }
  useEffect(() => {
    void run<State>("ssh.get").then((v) => v && setState(v));
    return api.subscribe((event) => {
      if (event.type === "ssh.changed") setState(event.data);
    });
  }, []);
  if (!state) return error ? <p className="alert">{error}</p> : null;
  const own = state.hosts.filter((h) => h.source === "otter");
  const config = state.hosts.filter((h) => h.source === "config");
  async function act(id: string, kind: "test" | "open") {
    setBusy(`${kind}:${id}`);
    const result = await run<{ ok: boolean; message: string }>(`ssh.${kind}`, {
      id,
    });
    if (result) setResults((r) => ({ ...r, [id]: result }));
    setBusy(null);
  }
  const row = (h: Host) => (
    <article key={h.id} className="ssh-host" aria-label={`服务器：${h.name}`}>
      <div className="setting-line">
        <span>
          <strong>{h.name}</strong>
          <small>
            {where(h)} · {authText(h)}
            {h.jump ? ` · 经 ${h.jump}` : ""}
          </small>
        </span>
        <span className="ssh-actions">
          <button
            disabled={!!busy}
            aria-label={`打开终端 ${h.name}`}
            onClick={() => void act(h.id, "open")}
          >
            打开终端
          </button>
          <button
            disabled={!!busy}
            aria-label={`测试连接 ${h.name}`}
            onClick={() => void act(h.id, "test")}
          >
            {busy === `test:${h.id}` ? "测试中…" : "测试连接"}
          </button>
          {h.source === "otter" && (
            <button
              className="chat-link"
              aria-label={`编辑 ${h.name}`}
              onClick={() =>
                setDraft({
                  id: h.id,
                  name: h.name,
                  host: h.host,
                  port: String(h.port),
                  user: h.user,
                  auth: h.auth || "agent",
                  keyPath: short(h.keyPath),
                  jump: h.jump || "",
                  note: h.note || "",
                  password: "",
                })
              }
            >
              编辑
            </button>
          )}
          {h.source === "otter" && (
            <button
              className="chat-link"
              aria-label={`删除 ${h.name}`}
              onClick={() => setRemoving(h.id)}
            >
              删除
            </button>
          )}
        </span>
      </div>
      {h.note && <p className="card-note">{h.note}</p>}
      {results[h.id] && (
        <p
          className={`ssh-result ${results[h.id].ok ? "ok" : "bad"}`}
          role="status"
        >
          {results[h.id].message}
        </p>
      )}
      {removing === h.id && (
        <div className="section-foot">
          <small>删除后，钥匙串里存的密码也一起删掉。</small>
          <button
            className="danger"
            onClick={async () => {
              const next = await run<State>("ssh.remove", { id: h.id });
              if (next) setState(next);
              setRemoving(null);
            }}
          >
            确认删除
          </button>
          <button onClick={() => setRemoving(null)}>保留</button>
        </div>
      )}
    </article>
  );
  const field = (
    key: keyof Draft,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <label className="setting-line">
      <span>{label}</span>
      <input
        aria-label={label}
        value={String(draft![key] ?? "")}
        onChange={(e) => setDraft({ ...draft!, [key]: e.target.value })}
        {...props}
      />
    </label>
  );
  return (
    <>
      <section className="settings-section ssh-section" aria-label="我的服务器">
        <div className="setting-row">
          <div>
            <h2>我的服务器</h2>
            <p>
              保存常用服务器的登录方式，一键在终端打开。密码只存进这台 Mac
              的钥匙串；也可以在聊天里说“保存服务器 名字：用户@主机……”。
            </p>
          </div>
          {!draft && (
            <button className="chat-new" onClick={() => setDraft({ ...empty })}>
              添加服务器
            </button>
          )}
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {!own.length && !draft && (
          <p className="card-empty">还没有保存服务器。</p>
        )}
        {own.map(row)}
        {draft && (
          <form
            className="ssh-form"
            aria-label={draft.id ? "编辑服务器" : "添加服务器"}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy("save");
              const next = await run<State>("ssh.save", {
                id: draft.id,
                server: {
                  name: draft.name || draft.host,
                  host: draft.host,
                  port: Number(draft.port) || 22,
                  user: draft.user,
                  auth: draft.auth,
                  keyPath: draft.keyPath,
                  jump: draft.jump,
                  note: draft.note,
                },
                password: draft.auth === "password" ? draft.password : "",
              });
              setBusy(null);
              if (next) {
                setState(next);
                setDraft(null);
              }
            }}
          >
            {field("name", "名称", { placeholder: "比如 生产机" })}
            {field("host", "主机", { placeholder: "example.com 或 1.2.3.4" })}
            {field("port", "端口", { inputMode: "numeric" })}
            {field("user", "用户名", { placeholder: "root" })}
            <label className="setting-line">
              <span>登录方式</span>
              <select
                aria-label="登录方式"
                value={draft.auth}
                onChange={(e) =>
                  setDraft({ ...draft, auth: e.target.value as Draft["auth"] })
                }
              >
                <option value="key">SSH 密钥</option>
                <option value="agent">ssh-agent</option>
                <option value="password">密码</option>
              </select>
            </label>
            {draft.auth === "key" && (
              <label className="setting-line">
                <span>密钥文件</span>
                <span className="ssh-key">
                  <input
                    aria-label="密钥文件"
                    value={draft.keyPath}
                    onChange={(e) =>
                      setDraft({ ...draft, keyPath: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await run<string | null>("ssh.pick-key");
                      if (picked)
                        setDraft({ ...draft, keyPath: short(picked) });
                    }}
                  >
                    选择…
                  </button>
                </span>
              </label>
            )}
            {draft.auth === "password" && (
              <label className="setting-line">
                <span>
                  密码
                  <small>只存进钥匙串{draft.id ? "；留空则不改" : ""}</small>
                </span>
                <input
                  type="password"
                  aria-label="密码"
                  autoComplete="new-password"
                  value={draft.password}
                  onChange={(e) =>
                    setDraft({ ...draft, password: e.target.value })
                  }
                />
              </label>
            )}
            {field("jump", "跳板机（可选）", {
              placeholder: "user@bastion:22",
            })}
            {field("note", "备注（可选）")}
            <div className="section-foot">
              <button
                className="primary"
                type="submit"
                disabled={busy === "save"}
              >
                保存服务器
              </button>
              <button type="button" onClick={() => setDraft(null)}>
                取消
              </button>
            </div>
          </form>
        )}
      </section>
      <section
        className="settings-section ssh-section"
        aria-label="ssh config 里的主机"
      >
        <h2>~/.ssh/config 里的主机</h2>
        <p>
          直接读取你的 ssh 配置，在这里只能连接和测试；要改请编辑{" "}
          {short(state.configFile)}。
        </p>
        {config.length ? (
          config.map(row)
        ) : (
          <p className="card-empty">
            没有找到 ~/.ssh/config，或者里面没有具体的主机。
          </p>
        )}
      </section>
    </>
  );
}
