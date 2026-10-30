import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { Otter, onHead, type Mood } from "./Otter";
import { Icon } from "./icons";
import otterFace from "./assets/otter/idle.gif?inline";
import { useEvolution } from "./evolution-runtime";
import type { Health, Job, Report, Prefs, Snapshot } from "./types";
import "./style.css";
import { AmbientSettings } from "./AmbientSettings";
import { BodySettings } from "./BodySettings";
import { ProjectsPane } from "./ProjectsPane";
import { TodayPane } from "./TodayPane";
import { QuickAccessCard } from "./QuickAccessCard";
import { AwarenessPane } from "./AwarenessPane";
import { DesktopTips, PetInteractions, usePetState } from "./PetInteractions";
import { EvolutionWorkshop } from "./EvolutionWorkshop";
import { ChatPane } from "./ChatPane";
import { MemoryPane } from "./MemoryPane";
import { HandoffPane } from "./HandoffPane";
import { ModelSettings } from "./ModelSettings";
import { VoiceSettings } from "./VoiceControls";
import { ExtensionsPane } from "./ExtensionsPane";
import { SshPane } from "./SshPane";
import { SettingsSheet, type SettingsSection } from "./SettingsSheet";
import { ThemePicker, applyTheme, isTheme, useTheme } from "./ThemePicker";
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
  const [version, setVersion] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    quiet: false,
    hidden: false,
    config: "",
  });
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  useTheme(prefs.theme);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const unsubscribe = api.subscribe((event) => {
      revision++;
      if (event.type === "voice.activity") setSpeaking(event.data.speaking);
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
        if (active) {
          setPrefs(s.preferences);
          setVersion(s.version || "请重启应用");
        }
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
    speaking,
    version,
  };
}
function Pet() {
  const { state: evolution } = useEvolution();
  const { health, job, prefs, chatBusy, speaking } = useRuntime();
  const { pet: petLocal, notice, interact } = usePetState();
  const [held, setHeld] = useState(false);
  const head = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const hit = useRef(false);
  const working =
    chatBusy || (health && job && ["queued", "running"].includes(job.status));
  const mood: Mood = held
    ? "held"
    : speaking
      ? "speaking"
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
        if (!start.current) setHit(false);
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
          head.current =
            !!rect &&
            onHead(
              (e.clientY - rect.top) / rect.height,
              evolution?.settings.enabled && ["idle", "working"].includes(mood)
                ? evolution.live.form
                : "companion",
            );
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
        <Otter mood={mood} size={200} />
      </button>
      <div className="pet-caption">
        {held
          ? "被你提起来啦！"
          : speaking
            ? "我在说给你听…"
            : notice ||
              petLocal.effect?.caption ||
              (!petLocal.asleep &&
              evolution?.settings.enabled &&
              evolution.live.form !== "companion"
                ? evolution.live.caption
                : "") ||
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
    version,
  } = useRuntime();
  // Three everyday places, the otter's own page, and settings in a sheet on top.
  const [place, setPlace] = useState<"today" | "chat" | "projects" | "otter">(
    "today",
  );
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [handoffPending, setHandoffPending] = useState(0);
  const [projectFocus, setProjectFocus] = useState<string | null>(null);
  const [memoryFocus, setMemoryFocus] = useState<string | null>(null);
  // Text typed on 今天, handed to chat to send.
  const [ask, setAsk] = useState<string | null>(null);
  const mainScroll = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mainScroll.current?.scrollTo({ top: 0 });
  }, [place]);
  // The menu bar, the pet, notifications and actions inside settings (such as
  // "chat about this") still name the old sections. Going to a place closes the
  // settings sheet, which would otherwise sit over it.
  function open(view: string | undefined) {
    if (view === "handoff") {
      setSettings("handoff");
      return true;
    }
    const next = ({ chat: "chat", pet: "otter", assistant: "today" } as const)[
      view as "chat" | "pet" | "assistant"
    ];
    if (!next) return false;
    setSettings(null);
    setPlace(next);
    return true;
  }
  useEffect(() => {
    let navigated = false;
    const unsub = api.subscribe((event) => {
      if (event.type === "navigation" && open(event.data.view))
        navigated = true;
    });
    void api.action<Snapshot>("snapshot").then((s) => {
      if (!navigated) open(s.view);
    });
    return unsub;
  }, []);
  useEffect(() => {
    const off = api.subscribe((event) => {
      if (event.type === "handoff.changed")
        setHandoffPending(event.data.pending.length);
    });
    void api
      .action<{ pending: unknown[] }>("handoff.get")
      .then((s) => setHandoffPending(s.pending.length))
      .catch(() => {});
    return off;
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
  const connectionLabel = connecting
    ? "正在连接"
    : health
      ? health.demo
        ? "离线演示模式"
        : "已连接 Otter"
      : "后台未连接";
  const hasToday = !!health && reports.some((r) => r.date === health.today);
  const reportCard = (
    <section className="today-card report-card" aria-label="简报">
      <span className="card-icon">
        <Icon name="reports" />
      </span>
      <div>
        <strong>
          {busy
            ? "正在整理简报…"
            : hasToday
              ? "今天的简报整理好了"
              : "今天的简报"}
        </strong>
        <small role="status">
          {job?.status === "failed"
            ? job.message
            : busy
              ? job?.message || "整理好会告诉你。"
              : health?.demo
                ? "演示模式，用本地模拟模型整理。"
                : hasToday
                  ? "就在下面，随时翻看。"
                  : "下班前，我可以帮你写一份。"}
          {job?.warnings?.length ? ` · ${job.warnings.join("；")}` : ""}
        </small>
        <details className="report-options">
          <summary>选项</summary>
          <label>
            日期
            <input
              aria-label="简报日期"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={!health || busy}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={collect}
              disabled={!health || busy || health.demo}
              onChange={(e) => setCollect(e.target.checked)}
            />
            先采集已启用的数据源
          </label>
          {health?.demo && (
            <button className="link" onClick={() => setSettings("workspace")}>
              连接我的 Otter →
            </button>
          )}
        </details>
      </div>
      <button
        className={hasToday ? "" : "primary"}
        disabled={!health || busy || !date}
        onClick={generate}
      >
        {busy ? "正在整理…" : "生成简报"}
      </button>
    </section>
  );
  const reportArchive = reports.length > 0 && (
    <section className="today-reports" aria-label="简报档案">
      <div className="section-title">
        <h2>简报</h2>
        <button disabled={!health || loading} onClick={() => refresh()}>
          刷新
        </button>
      </div>
      <div className="report-grid">
        <div className="report-list" aria-label="历史简报">
          {reports.map((r) => (
            <button
              key={r.date}
              className={selected?.date === r.date ? "selected" : ""}
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
    </section>
  );
  const alert = error && (
    <div role="alert" className="alert">
      {error}
      <button aria-label="关闭错误提示" onClick={() => setError("")}>
        ×
      </button>
    </div>
  );
  return (
    <div className="app-shell">
      <aside className="rail">
        <nav aria-label="主导航">
          <button
            className={place === "today" ? "active" : ""}
            onClick={() => setPlace("today")}
          >
            <Icon name="today" />
            今天
          </button>
          <button
            className={place === "chat" ? "active" : ""}
            onClick={() => setPlace("chat")}
          >
            <Icon name="chat" />
            聊天
          </button>
          <button
            className={place === "projects" ? "active" : ""}
            onClick={() => setPlace("projects")}
          >
            <Icon name="projects" />
            项目
          </button>
        </nav>
        <div className="rail-foot">
          <button
            className={`rail-otter ${place === "otter" ? "active" : ""}`}
            aria-label="我的水獭"
            title={`我的水獭 · ${connectionLabel}`}
            onClick={() => setPlace("otter")}
          >
            <img src={otterFace} alt="" />
          </button>
          <button
            className="rail-gear"
            aria-label="设置"
            title="设置"
            onClick={() => setSettings("general")}
          >
            <Icon name="settings" />
            {!!handoffPending && (
              <em
                className="nav-badge"
                aria-label={`${handoffPending} 个待批准`}
              >
                {handoffPending}
              </em>
            )}
          </button>
        </div>
      </aside>
      <main ref={mainScroll}>
        <header className="topbar">
          {/* Only an unusual connection needs saying; a working one stays quiet. */}
          {health && !health.demo ? (
            <span />
          ) : (
            <span className="status-pill">
              <span className={health ? "dot online" : "dot"} />
              {connectionLabel}
            </span>
          )}
          <span>OTTER {version}</span>
        </header>
        <div className="content">
          {alert}
          {place === "projects" ? (
            health ? (
              <ProjectsPane key={prefs.config} focusId={projectFocus} />
            ) : (
              <p className="muted">正在连接项目数据…</p>
            )
          ) : place === "chat" ? (
            <ChatPane
              key={prefs.config}
              health={health}
              initialDraft={ask}
              onDraftTaken={() => setAsk(null)}
              onSettings={() => setSettings("model")}
              onProjects={(id) => {
                setProjectFocus(id || null);
                setPlace("projects");
              }}
              onEditMemory={(id) => {
                setMemoryFocus(id);
                setPlace("otter");
              }}
            />
          ) : place === "otter" ? (
            <>
              <PetInteractions />
              <MemoryPane
                key={prefs.config}
                focus={memoryFocus}
                onFocused={() => setMemoryFocus(null)}
              />
              <EvolutionWorkshop />
              <DesktopTips />
            </>
          ) : (
            <TodayPane
              health={health}
              handoffPending={handoffPending}
              report={{ card: reportCard, archive: reportArchive }}
              onAsk={(text) => {
                setAsk(text);
                setPlace("chat");
              }}
              onOpenProject={(id) => {
                setProjectFocus(id || null);
                setPlace("projects");
              }}
              onOpenHandoff={() => setSettings("handoff")}
            />
          )}
        </div>
      </main>
      {settings && (
        <SettingsSheet
          section={settings}
          alert={alert}
          onClose={() => setSettings(null)}
          sections={[
            {
              id: "general",
              label: "通用",
              content: (
                <>
                  <ThemePicker
                    value={isTheme(prefs.theme) ? prefs.theme : "warm"}
                    onChange={(theme) => {
                      const before = prefs.theme;
                      setPrefs((previous) => ({ ...previous, theme }));
                      void api.action("theme", theme).catch((error) => {
                        setPrefs((previous) => ({
                          ...previous,
                          theme: before,
                        }));
                        setError(message(error));
                      });
                    }}
                  />
                  <section className="settings-section">
                    <div className="setting-row">
                      <div>
                        <h2>安静模式</h2>
                        <p>简报完成时不弹系统通知。</p>
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
                  <AmbientSettings />
                  <QuickAccessCard />
                </>
              ),
            },
            {
              id: "model",
              label: "模型",
              content: (
                <>
                  <ModelSettings
                    key={prefs.config}
                    connected={!!health}
                    blocked={!!busy || connecting || chatBusy}
                  />
                  <section className="settings-section">
                    <VoiceSettings />
                  </section>
                </>
              ),
            },
            {
              id: "tools",
              label: "工具与扩展",
              content: health ? (
                <ExtensionsPane key={prefs.config} />
              ) : (
                <p className="muted">正在连接…</p>
              ),
            },
            { id: "ssh", label: "SSH 服务器", content: <SshPane /> },
            { id: "privacy", label: "隐私与感知", content: <AwarenessPane /> },
            {
              id: "handoff",
              label: "AI 交接",
              badge: handoffPending,
              content: health ? (
                <HandoffPane key={prefs.config} />
              ) : (
                <p className="muted">正在连接项目数据…</p>
              ),
            },
            { id: "body", label: "实体水獭", content: <BodySettings /> },
            {
              id: "workspace",
              label: "工作空间",
              content: (
                <>
                  <section className="settings-section">
                    <h2>配置文件</h2>
                    <p>
                      选一个现有的 config.toml
                      和它的项目目录，沿用原来的数据库和密钥引用。
                    </p>
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
                    <p>关掉面板后，水獭还在菜单栏；退出应用会停掉后台任务。</p>
                  </section>
                </>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
const query = new URLSearchParams(location.search);
const view = query.get("view");
// The main process passes the theme in the URL, so the first paint is already
// in the right colours; the setting takes over once the snapshot arrives.
applyTheme(query.get("theme"));
document.documentElement.dataset.view = view === "pet" ? "pet" : "panel";
document.body.className = view === "pet" ? "pet-mode" : "panel-mode";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view === "pet" ? <Pet /> : <Panel />}</React.StrictMode>,
);
