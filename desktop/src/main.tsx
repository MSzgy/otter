import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { Otter, type Mood } from "./Otter";
import type { Health, Job, Report, Prefs, Snapshot } from "./types";
import "./style.css";
import { AwarenessPane } from "./AwarenessPane";
import { PetInteractions, usePetState } from "./PetInteractions";
import { ChatPane } from "./ChatPane";
import { ModelSettings } from "./ModelSettings";
const api = window.otter;
function message(error: unknown) {
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      )
    : String(error);
}
function useRuntime() {
  const [health, setHealth] = useState<Health | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    quiet: false,
    hidden: false,
    config: "",
  });
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const unsubscribe = api.subscribe((event) => {
      revision++;
      if (event.type === "connection") {
        setConnecting(event.data.status === "connecting");
        setHealth(event.data.health || null);
        setError(event.data.message || "");
        if (event.data.status === "connecting") setJob(null);
        if (event.data.status !== "online") setChatBusy(false);
      }
      if (["chat.changed", "chat.activity"].includes(event.type))
        setChatBusy(event.data.status === "streaming");
      if (event.type === "job.changed") setJob(event.data);
      if (event.type === "preferences") setPrefs(event.data);
    });
    const version = revision;
    api
      .action<Snapshot>("snapshot")
      .then((s) => {
        if (active) setPrefs(s.preferences);
        if (active && revision === version) {
          setHealth(s.health);
          setJob(s.job);
          setChatBusy(s.chat?.status === "streaming");
          setPrefs(s.preferences);
          setError(s.message);
          setConnecting(s.switching || (!s.health && !s.message));
        }
      })
      .catch((e) => {
        if (active) {
          setError(message(e));
          setConnecting(false);
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return {
    health,
    job,
    prefs,
    setPrefs,
    error,
    setError,
    connecting,
    chatBusy,
  };
}
function Pet() {
  const { health, job, prefs, chatBusy } = useRuntime();
  const { pet: petLocal, notice, interact } = usePetState();
  const [held, setHeld] = useState(false);
  const gaze = useRef({ x: 0, y: 0 });
  const head = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const hit = useRef(false);
  const working =
    chatBusy || (health && job && ["queued", "running"].includes(job.status));
  const mood: Mood = held
    ? "held"
    : petLocal.effect
      ? petLocal.mood
      : petLocal.asleep
        ? "sleeping"
        : working
          ? "working"
          : "idle";
  function setHit(value: boolean) {
    if (hit.current !== value) {
      hit.current = value;
      void api.action("hit", value).catch(() => {});
    }
  }
  return (
    <div
      className="pet-root"
      onPointerMove={(e) => {
        if (start.current) {
          if (
            Math.hypot(
              e.screenX - start.current.x,
              e.screenY - start.current.y,
            ) > 4
          )
            moved.current = true;
          if (moved.current) {
            setHeld(true);
            void api.action("drag-move").catch(() => {});
          }
        } else {
          const canvas = e.currentTarget.querySelector("canvas");
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            const x = Math.floor(
              ((e.clientX - rect.left) * canvas.width) / rect.width,
            );
            const y = Math.floor(
              ((e.clientY - rect.top) * canvas.height) / rect.height,
            );
            gaze.current = {
              x: Math.max(
                -1,
                Math.min(1, ((e.clientX - rect.left) / rect.width - 0.5) * 2),
              ),
              y: Math.max(
                -1,
                Math.min(1, ((e.clientY - rect.top) / rect.height - 0.5) * 2),
              ),
            };
            const inside =
              x >= 0 && y >= 0 && x < canvas.width && y < canvas.height;
            setHit(
              inside &&
                (canvas.getContext("2d")?.getImageData(x, y, 1, 1).data[3] ||
                  0) > 32,
            );
          } else setHit(false);
        }
      }}
      onPointerLeave={() => {
        if (!start.current) {
          setHit(false);
          gaze.current = { x: 0, y: 0 };
        }
      }}
    >
      <button
        data-interactive
        className="pet-body"
        aria-label="与水獭聊天"
        title="点头摸摸 · 点身体聊天 · 右键更多互动"
        onContextMenu={(e) => {
          e.preventDefault();
          start.current = null;
          setHeld(false);
          void api
            .action("drag-end")
            .then(() => api.action("pet.menu"))
            .finally(() => {
              hit.current = false;
            })
            .catch(() => {});
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          start.current = { x: e.screenX, y: e.screenY };
          const rect = e.currentTarget
            .querySelector("canvas")
            ?.getBoundingClientRect();
          head.current = !!rect && (e.clientY - rect.top) / rect.height < 0.47;
          moved.current = false;
          e.currentTarget.setPointerCapture(e.pointerId);
          void api.action("drag-start").catch(() => {});
        }}
        onPointerUp={() => {
          if (!start.current) return;
          start.current = null;
          void api.action("drag-end").catch(() => {});
          setHeld(false);
          if (!moved.current) {
            if (petLocal.asleep) void interact("wake");
            else if (head.current) void interact("pet");
            else void api.action("open-chat").catch(() => {});
          }
        }}
        onPointerCancel={() => {
          setHeld(false);
          start.current = null;
          void api.action("drag-end").catch(() => {});
        }}
      >
        <Otter mood={mood} size={200} gaze={gaze} />
      </button>
      <div className="pet-caption">
        {held
          ? "被你提起来啦！"
          : notice ||
            petLocal.effect?.caption ||
            (petLocal.asleep
              ? "点一下，叫醒我"
              : working
                ? chatBusy
                  ? "让我想想…"
                  : "正在整理简报"
                : "点头摸摸 · 右键互动")}
      </div>
    </div>
  );
}
function Panel() {
  const {
    health,
    job,
    prefs,
    setPrefs,
    error,
    setError,
    connecting,
    chatBusy,
  } = useRuntime();
  const { pet: petLocal } = usePetState();
  const [tab, setTab] = useState<
    "reports" | "settings" | "chat" | "pet" | "awareness"
  >("reports");
  useEffect(() => {
    let navigated = false;
    const unsub = api.subscribe((event) => {
      if (
        event.type === "navigation" &&
        ["chat", "pet"].includes(event.data.view)
      ) {
        navigated = true;
        setTab(event.data.view);
      }
    });
    void api.action<Snapshot>("snapshot").then((s) => {
      if (!navigated && (s.view === "chat" || s.view === "pet")) setTab(s.view);
    });
    return unsub;
  }, []);
  const [reports, setReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<Report | null>(null);
  const [date, setDate] = useState("");
  const [collect, setCollect] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const selectionRevision = useRef(0);
  const busy =
    submitting ||
    !!(job && ["queued", "running"].includes(job.status) && health);
  async function loadReport(day: string) {
    const revision = ++selectionRevision.current;
    setLoading(true);
    try {
      const r = await api.call<Report | null>("reports.get", { date: day });
      if (revision === selectionRevision.current) setSelected(r);
    } catch (e) {
      setError(message(e));
    } finally {
      if (revision === selectionRevision.current) setLoading(false);
    }
  }
  async function refresh(day?: string) {
    try {
      const rows = await api.call<Report[]>("reports.list");
      setReports(rows);
      if (day || rows[0]) await loadReport(day || rows[0].date);
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    if (health) {
      setDate(health.today);
      setCollect(false);
      setSelected(null);
      setReports([]);
      void refresh();
    } else {
      selectionRevision.current++;
      setLoading(false);
    }
  }, [health]);
  useEffect(() => {
    if (job?.status === "finished") void refresh(job.date);
  }, [job?.id, job?.status]);
  async function action(name: string, value?: unknown) {
    setError("");
    try {
      await api.action(name, value);
    } catch (e) {
      setError(message(e));
    }
  }
  async function generate() {
    setError("");
    setSubmitting(true);
    try {
      await api.call("reports.generate", { date, collect });
    } catch (e) {
      setError(message(e));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">o.</span>
          <div>
            Otter<small>你的桌面伙伴</small>
          </div>
        </div>
        <nav aria-label="主导航">
          <button
            className={tab === "awareness" ? "active" : ""}
            onClick={() => setTab("awareness")}
          >
            <span>◉</span>应用感知
          </button>
          <button
            className={tab === "pet" ? "active" : ""}
            onClick={() => setTab("pet")}
          >
            <span>♡</span>陪伴互动
          </button>
          <button
            className={tab === "chat" ? "active" : ""}
            onClick={() => setTab("chat")}
          >
            <span>◌</span>与水獭聊天
          </button>
          <button
            className={tab === "reports" ? "active" : ""}
            onClick={() => setTab("reports")}
          >
            <span>▤</span>工作简报
          </button>
          <button
            className={tab === "settings" ? "active" : ""}
            onClick={() => setTab("settings")}
          >
            <span>⚙</span>偏好设置
          </button>
        </nav>
        <div className="companion">
          <Otter
            size={158}
            mood={
              petLocal.effect
                ? petLocal.mood
                : petLocal.asleep
                  ? "sleeping"
                  : busy || chatBusy
                    ? "working"
                    : "idle"
            }
          />
          <strong>{busy ? "让我整理一下" : "安静地，陪你工作"}</strong>
          <p>
            {busy
              ? "准备好后会告诉你。"
              : "把工作留在简报里，\n把注意力留给现在。"}
          </p>
        </div>
        <div className="connection">
          <span className={health ? "dot online" : "dot"} />
          {connecting
            ? "正在连接"
            : health
              ? health.demo
                ? "离线演示模式"
                : "已连接 Otter"
              : "后台未连接"}
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            {tab === "reports"
              ? "工作空间 / 简报"
              : tab === "chat"
                ? "Otter / 聊天"
                : tab === "pet"
                  ? "Otter / 陪伴互动"
                  : tab === "awareness"
                    ? "Otter / 应用感知"
                    : "工作空间 / 设置"}
          </span>
          <span>OTTER DESKTOP</span>
        </header>
        <div className="content">
          {error && (
            <div role="alert" className="alert">
              {error}
              <button aria-label="关闭错误提示" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {tab === "awareness" ? (
            <AwarenessPane />
          ) : tab === "pet" ? (
            <PetInteractions />
          ) : tab === "chat" ? (
            <ChatPane
              key={prefs.config}
              health={health}
              onSettings={() => setTab("settings")}
            />
          ) : tab === "reports" ? (
            <>
              <div className="heading">
                <div>
                  <p className="eyebrow">一点回顾，一点从容</p>
                  <h1>接着昨天，继续今天。</h1>
                  <p className="muted">
                    你的工作记录，已经有了一个安放的地方。
                  </p>
                </div>
              </div>
              {health?.demo && (
                <div className="demo-note">
                  <span>演示模式</span> 使用本地模拟模型，不读取工作数据、不产生
                  API 费用。
                  <button onClick={() => setTab("settings")}>
                    连接我的 Otter →
                  </button>
                </div>
              )}
              <section className="generate-box" aria-label="生成简报">
                <div className="generate-top">
                  <div>
                    <strong>整理一份简报</strong>
                    <p>选择日期，回顾那一天的工作。</p>
                  </div>
                  <div className="generate-controls">
                    <input
                      aria-label="简报日期"
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      disabled={!health || busy}
                    />
                    <button
                      className="primary"
                      disabled={!health || busy || !date}
                      onClick={generate}
                    >
                      {busy ? "正在整理…" : "生成简报"}
                    </button>
                  </div>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={collect}
                    disabled={!health || busy || health.demo}
                    onChange={(e) => setCollect(e.target.checked)}
                  />
                  生成前采集已启用的数据源
                  <span>
                    {health && !health.demo
                      ? `模型：${health.model || health.provider} · 生成将调用已配置的模型`
                      : "仅演示已有流程"}
                  </span>
                </label>
              </section>
              {job && (
                <div className={`job-status ${job.status}`} role="status">
                  <span>
                    {job.status === "finished"
                      ? "✓"
                      : job.status === "failed"
                        ? "!"
                        : "◌"}
                  </span>
                  <div>
                    {job.message}
                    <small>
                      {job.date}
                      {job.warnings?.length
                        ? ` · ${job.warnings.join("；")}`
                        : ""}
                    </small>
                  </div>
                </div>
              )}
              <section className="archive">
                <div className="section-title">
                  <h2>简报档案</h2>
                  <button
                    disabled={!health || loading}
                    onClick={() => refresh()}
                  >
                    刷新
                  </button>
                </div>
                {reports.length === 0 ? (
                  <div className="empty">
                    <span className="empty-symbol">▤</span>
                    <h3>
                      {connecting
                        ? "正在打开你的工作空间"
                        : "第一份简报，从这里开始"}
                    </h3>
                    <p>
                      {health
                        ? "生成一份简报后，它会保存在这里。"
                        : "请在偏好设置中检查连接。"}
                    </p>
                  </div>
                ) : (
                  <div className="report-grid">
                    <div className="report-list" aria-label="历史简报">
                      {reports.map((r) => (
                        <button
                          key={r.date}
                          className={
                            selected?.date === r.date ? "selected" : ""
                          }
                          onClick={() => loadReport(r.date)}
                        >
                          <strong>{r.date}</strong>
                          <small>
                            {r.llm_provider === "mock"
                              ? "演示简报"
                              : `${r.event_count} 条工作记录`}
                          </small>
                        </button>
                      ))}
                    </div>
                    <article className="report-body" aria-busy={loading}>
                      {loading ? (
                        <p className="muted">正在打开简报…</p>
                      ) : selected ? (
                        <>
                          <div className="report-meta">
                            {selected.llm_provider === "mock"
                              ? "离线演示"
                              : selected.llm_model}{" "}
                            · {selected.date}
                          </div>
                          <Markdown
                            skipHtml
                            components={{
                              a: ({ href, children }) => (
                                <a
                                  href={href}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    if (href) void action("open-link", href);
                                  }}
                                >
                                  {children}
                                </a>
                              ),
                              img: () => null,
                            }}
                          >
                            {selected.content_md || ""}
                          </Markdown>
                        </>
                      ) : (
                        <p>没有找到该日期的简报。</p>
                      )}
                    </article>
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              <div className="heading">
                <p className="eyebrow">让陪伴刚刚好</p>
                <h1>按你的节奏来。</h1>
                <p className="muted">
                  连接现有工作空间，选择你喜欢的相处方式。
                </p>
              </div>
              <ModelSettings
                key={prefs.config}
                connected={!!health}
                blocked={!!busy || connecting || chatBusy}
              />
              <section className="settings-section">
                <h2>工作空间</h2>
                <p>
                  选择现有的
                  config.toml，再选择它对应的项目根目录。沿用原有数据库与密钥引用，不复制密钥。
                </p>
                <div className="path-label">当前配置</div>
                <code className="config-path">
                  {prefs.config || "正在读取…"}
                </code>
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={busy || connecting || prefs.envConfig}
                    onClick={() => action("choose-config")}
                  >
                    选择现有配置
                  </button>
                  <button
                    disabled={busy || connecting}
                    onClick={() => action("reconnect")}
                  >
                    重新连接
                  </button>
                  <button
                    disabled={busy || connecting || prefs.envConfig}
                    onClick={() => action("use-demo")}
                  >
                    使用离线演示
                  </button>
                </div>
                {prefs.envConfig && (
                  <p>配置由启动环境变量指定，请调整启动参数后重启。</p>
                )}
              </section>
              <section className="settings-section">
                <div className="setting-row">
                  <div>
                    <h2>安静模式</h2>
                    <p>关闭简报完成时的系统通知，仍显示任务状态。</p>
                  </div>
                  <input
                    aria-label="安静模式"
                    className="toggle"
                    type="checkbox"
                    checked={prefs.quiet}
                    onChange={(e) => {
                      const quiet = e.target.checked;
                      setPrefs((previous) => ({ ...previous, quiet }));
                      void api.action("quiet", quiet).catch((error) => {
                        setPrefs((previous) => ({
                          ...previous,
                          quiet: !quiet,
                        }));
                        setError(message(error));
                      });
                    }}
                  />
                </div>
              </section>
              <section className="settings-section">
                <h2>连接状态</h2>
                <dl>
                  <dt>模型</dt>
                  <dd>
                    {health
                      ? `${health.provider}${health.model ? " / " + health.model : ""}`
                      : "未连接"}
                  </dd>
                  <dt>时区</dt>
                  <dd>{health?.timezone || "—"}</dd>
                  <dt>启用的数据源</dt>
                  <dd>{health?.collectors.join("、") || "无"}</dd>
                </dl>
                <p>
                  关闭面板后，水獭仍驻留在菜单栏。退出应用会停止后台任务。当前版本提供宠物聊天和工作简报；提醒与语音在后续阶段接入。
                </p>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
const view = new URLSearchParams(location.search).get("view");
document.documentElement.dataset.view = view === "pet" ? "pet" : "panel";
document.body.className = view === "pet" ? "pet-mode" : "panel-mode";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view === "pet" ? <Pet /> : <Panel />}</React.StrictMode>,
);
