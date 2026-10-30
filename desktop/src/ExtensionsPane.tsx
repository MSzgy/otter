import { useEffect, useState } from "react";
import "./types";
import { SkillsCard, type Skills } from "./SkillsCard";

type Tool = {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  autoApprove: boolean;
};
// A local server shows what it runs; a remote one, where it connects.
type Target = {
  name: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
  url?: string;
  transport?: "http" | "sse";
  headerKeys?: string[];
};
type Server = Target & {
  id: string;
  enabled: boolean;
  status: "off" | "starting" | "ready" | "error";
  message: string;
  tools: Tool[];
};
type State = {
  tools: boolean;
  builtins: string[];
  servers: Server[];
  skills: Skills | null;
};
type Preview = Target;
function where(t: Target) {
  if (t.url) {
    const keys = t.headerKeys?.length
      ? `，请求头：${t.headerKeys.join("、")}`
      : "";
    return `${t.url}（${t.transport === "sse" ? "SSE" : "HTTP"}${keys}）`;
  }
  const keys = t.envKeys?.length ? `（环境变量：${t.envKeys.join("、")}）` : "";
  return [t.command, ...(t.args || [])].join(" ") + keys;
}

const api = window.otter;
const EXAMPLE = `{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/你/Documents"]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer 你的令牌" }
    }
  }
}`;
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);
}
function statusText(s: Server) {
  if (!s.enabled) return "已关闭";
  if (s.status === "ready") return `运行中 · ${s.tools.length} 个工具`;
  if (s.status === "starting") return "正在启动…";
  if (s.status === "error") return `出错：${s.message}`;
  return "未运行";
}

// 工具与扩展: whether chat may call tools, Otter's own ones, and MCP servers.
export function ExtensionsPane() {
  const [state, setState] = useState<State | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview[] | null>(null);
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
  // Switches flip at once and settle on the answer, or go back on an error.
  async function change(name: string, value: unknown, optimistic: State) {
    setState(optimistic);
    const next = await run<State>(name, value);
    if (next) setState((current) => ({ ...(current || optimistic), ...next }));
    else void refresh();
  }
  const withServer = (id: string, edit: (s: Server) => Server): State => ({
    ...state!,
    servers: state!.servers.map((s) => (s.id === id ? edit(s) : s)),
  });
  async function refresh() {
    const value = await run<State>("extensions.get");
    if (value) setState(value);
  }
  useEffect(() => {
    void refresh();
    return api.subscribe((event) => {
      if (event.type === "extensions.changed")
        setState((current) =>
          current ? { ...current, ...event.data } : current,
        );
      if (event.type === "skills.changed")
        setState((current) =>
          current ? { ...current, skills: event.data } : current,
        );
    });
  }, []);
  if (!state) return error ? <p className="alert">{error}</p> : null;
  return (
    <>
      <section className="settings-section">
        <div className="setting-row">
          <div>
            <h2>让水獭调用工具</h2>
            <p>
              聊天时它可以用下面的工具查资料、做事。Otter
              自带的只读工具直接用，其他的每次先问你。
            </p>
          </div>
          <input
            type="checkbox"
            className="toggle"
            aria-label="允许聊天调用工具"
            checked={state.tools}
            onChange={(e) =>
              void change(
                "extensions.configure",
                { tools: e.target.checked },
                { ...state, tools: e.target.checked },
              )
            }
          />
        </div>
        <div className="tool-chips" aria-label="Otter 自带的工具">
          {state.builtins.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </section>
      <section className="settings-section mcp-section" aria-label="MCP 服务">
        <h2>MCP 服务</h2>
        <p>
          接上别人做好的工具，比如读文件、查日历。配置和 Claude Desktop 一样。
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {!state.servers.length && (
          <p className="card-empty">还没有接上 MCP 服务。</p>
        )}
        {state.servers.map((s) => (
          <article
            key={s.id}
            className="mcp-server"
            aria-label={`MCP 服务：${s.name}`}
          >
            <div className="setting-line">
              <span>
                <strong>{s.name}</strong>
                <small className={`mcp-status ${s.enabled ? s.status : "off"}`}>
                  {statusText(s)}
                </small>
              </span>
              <input
                type="checkbox"
                className="toggle"
                aria-label={`启用 ${s.name}`}
                checked={s.enabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  void change(
                    "extensions.server",
                    { id: s.id, enabled },
                    withServer(s.id, (x) => ({ ...x, enabled })),
                  );
                }}
              />
            </div>
            <code className="mcp-command">{where(s)}</code>
            {!!s.tools.length && (
              <details className="settings-more">
                <summary>它的工具 · {s.tools.length}</summary>
                {s.tools.map((t) => (
                  <label className="setting-line" key={t.name}>
                    <span>
                      {t.title}
                      <small>{t.description || t.name}</small>
                    </span>
                    <span className="unit-field">
                      不用再问
                      <input
                        type="checkbox"
                        className="toggle"
                        aria-label={`${t.title} 不用再问`}
                        checked={t.autoApprove}
                        onChange={(e) => {
                          const allow = e.target.checked;
                          void change(
                            "extensions.allow",
                            { id: s.id, tool: t.name, allow },
                            withServer(s.id, (x) => ({
                              ...x,
                              tools: x.tools.map((y) =>
                                y.name === t.name
                                  ? { ...y, autoApprove: allow }
                                  : y,
                              ),
                            })),
                          );
                        }}
                      />
                    </span>
                  </label>
                ))}
              </details>
            )}
            {removing === s.id ? (
              <div className="section-foot">
                <small>删除后要重新粘贴配置才能再用。</small>
                <button
                  className="danger"
                  onClick={async () => {
                    const next = await run<State>("extensions.remove", {
                      id: s.id,
                    });
                    if (next) setState({ ...state, ...next });
                    setRemoving(null);
                  }}
                >
                  确认删除
                </button>
                <button onClick={() => setRemoving(null)}>保留</button>
              </div>
            ) : (
              <button
                className="chat-link"
                aria-label={`删除 ${s.name}`}
                onClick={() => setRemoving(s.id)}
              >
                删除
              </button>
            )}
          </article>
        ))}
        <details className="settings-more" open={!state.servers.length}>
          <summary>添加 MCP 服务</summary>
          <textarea
            className="mcp-config"
            aria-label="MCP 配置"
            placeholder={EXAMPLE}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
          />
          {preview ? (
            <div className="mcp-preview" aria-label="将要添加的服务">
              {preview.some((p) => !p.url) && (
                <p>这会在你的 Mac 上运行下面的命令，只添加你信任的服务：</p>
              )}
              {preview.some((p) => p.url) && (
                <p>
                  会连接下面的网络服务；你允许的工具调用会把参数发给它，只添加你信任的服务：
                </p>
              )}
              {preview.map((p) => (
                <code key={p.name} className="mcp-command">
                  {p.name}：{where(p)}
                </code>
              ))}
              <div className="section-foot">
                <button
                  className="primary"
                  onClick={async () => {
                    const next = await run<State>("extensions.add", { text });
                    if (next) {
                      setState({ ...state, ...next });
                      setText("");
                      setPreview(null);
                    }
                  }}
                >
                  确认添加
                </button>
                <button onClick={() => setPreview(null)}>取消</button>
                <small>环境变量和请求头会保存在本机的设置文件里。</small>
              </div>
            </div>
          ) : (
            <div className="section-foot">
              <button
                disabled={!text.trim()}
                onClick={async () =>
                  setPreview(
                    await run<Preview[]>("extensions.preview", { text }),
                  )
                }
              >
                检查配置
              </button>
              <small>
                支持本机命令和网络服务（HTTP、SSE）。要网页登录的服务暂时不行，可以把令牌放在
                headers 里。
              </small>
            </div>
          )}
        </details>
      </section>
      {state.skills && (
        <SkillsCard
          skills={state.skills}
          run={run}
          onChange={(skills) =>
            setState((current) => (current ? { ...current, skills } : current))
          }
        />
      )}
    </>
  );
}
