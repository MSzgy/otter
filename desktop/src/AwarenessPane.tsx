import { useEffect, useState } from "react";
import "./types";
import { ApplicationContent } from "./ApplicationContent";
type App = { name: string; bundleId: string; pid: number };
type State = {
  enabled: boolean;
  browserEnabled: boolean;
  status: string;
  apps: App[];
  front: App | null;
  browser: {
    bundleId: string;
    name: string;
    title: string;
    url: string;
    observedAt: number;
  } | null;
  tabs: {
    bundleId: string;
    name: string;
    windowId: string;
    tabId: string;
    windowIndex: number;
    title: string;
    url: string;
    active: boolean;
  }[];
  tabWindowCount: number;
  tabsTruncated: boolean;
  browserStatus: string;
  updatedAt: number | null;
  message: string;
  supportedBrowsers: Record<string, string>;
};
const empty: State = {
  enabled: false,
  browserEnabled: false,
  status: "off",
  apps: [],
  front: null,
  browser: null,
  tabs: [],
  tabWindowCount: 0,
  tabsTruncated: false,
  browserStatus: "off",
  updatedAt: null,
  message: "",
  supportedBrowsers: {},
};
export function AwarenessPane() {
  const [state, setState] = useState<State>(empty);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [tabFilter, setTabFilter] = useState("");
  useEffect(() => {
    let alive = true,
      revision = 0;
    const off = window.otter.subscribe((e) => {
      if (e.type === "awareness.changed") {
        revision++;
        setState(e.data);
      }
    });
    const version = revision;
    void window.otter
      .action<State>("awareness.get")
      .then((s) => {
        if (alive && version === revision) setState(s);
      })
      .catch((e) => {
        if (alive) setError(String(e.message));
      });
    return () => {
      alive = false;
      off();
    };
  }, []);
  async function act(name: string, value?: unknown) {
    setPending(true);
    setError("");
    try {
      const s = await window.otter.action<State>(name, value);
      if (s && s.apps) setState(s);
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
      setPending(false);
    }
  }
  const browserApps = state.apps.filter(
    (a) => state.supportedBrowsers[a.bundleId],
  );
  const tabs = (state.tabs || []).filter((t) =>
    (t.title + " " + t.url).toLowerCase().includes(tabFilter.toLowerCase()),
  );
  const current = state.browser?.bundleId === state.front?.bundleId;
  return (
    <section className="awareness-pane" aria-label="应用感知">
      <div className="heading">
        <p className="eyebrow">先了解你正在做什么</p>
        <h1>看见你的工作现场。</h1>
        <p className="muted">
          只在本机展示应用和标签页信息，不自动发送给模型。
        </p>
      </div>
      <section className="awareness-controls">
        <div className="setting-row">
          <div>
            <h2>应用感知</h2>
            <p>每 4 秒更新运行中的桌面应用和当前前台应用。</p>
          </div>
          <input
            type="checkbox"
            className="toggle"
            aria-label="开启应用感知"
            checked={state.enabled}
            disabled={pending && !state.enabled}
            onChange={(e) =>
              act("awareness.configure", {
                enabled: e.target.checked,
                browserEnabled: e.target.checked && state.browserEnabled,
              })
            }
          />
        </div>
        <div className="setting-row browser-toggle">
          <div>
            <h2>浏览器标签页</h2>
            <p>
              列出支持浏览器所有窗口的现有标签页；选择具体标签页读取。首次可能弹出系统授权。
            </p>
          </div>
          <input
            type="checkbox"
            className="toggle"
            aria-label="开启浏览器感知"
            checked={state.browserEnabled}
            disabled={!state.enabled || (pending && !state.browserEnabled)}
            onChange={(e) =>
              act("awareness.configure", {
                enabled: state.enabled,
                browserEnabled: e.target.checked,
              })
            }
          />
        </div>
      </section>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {state.message && (
        <div className="alert" role="status">
          {state.message}
        </div>
      )}
      {state.enabled && (
        <div className="button-row">
          <button
            className="primary"
            disabled={pending || (!state.front && !state.browser)}
            onClick={() => act("context.scene")}
          >
            聊聊当前场景
          </button>
          <small>先预览，不会直接发送</small>
        </div>
      )}
      {!state.enabled ? (
        <div className="empty awareness-empty">
          <h3>感知已关闭</h3>
          <p>
            开启后，Otter
            才会读取当前应用列表。关闭会清空已展示的应用与标签页信息。
          </p>
        </div>
      ) : (
        <>
          <div className="section-title">
            <h2>当前前台应用</h2>
            <button disabled={pending} onClick={() => act("awareness.refresh")}>
              立即刷新
            </button>
          </div>
          <div className="foreground-card">
            <span className="app-letter">
              {state.front?.name.slice(0, 1) || "—"}
            </span>
            <div>
              <strong>{state.front?.name || "暂未识别"}</strong>
              <small>{state.front?.bundleId || "等待系统返回信息"}</small>
            </div>
            <time>
              {state.updatedAt
                ? new Date(state.updatedAt).toLocaleTimeString()
                : "尚未更新"}
            </time>
          </div>
          <div className="section-title">
            <h2>浏览器</h2>
            <button onClick={() => act("awareness.permissions")}>
              打开自动化权限设置
            </button>
          </div>
          {!state.browserEnabled ? (
            <p className="awareness-hint">
              浏览器感知未开启。应用列表仍可正常使用。
            </p>
          ) : (
            <>
              <div className="browser-actions">
                {browserApps.map((a) => (
                  <button
                    key={a.bundleId + ":" + a.pid}
                    disabled={pending}
                    onClick={() => act("awareness.browser", a.bundleId)}
                  >
                    {pending ? "读取中…" : `读取 ${a.name} 标签页`}
                  </button>
                ))}
              </div>
              {browserApps.length === 0 && (
                <p className="awareness-hint">
                  请打开 Safari、Chrome、Edge 或
                  Brave。其他浏览器会显示在应用列表中，暂不读取标签页。
                </p>
              )}
              {browserApps.length > 0 && (
                <div className="browser-actions page-read-actions">
                  {browserApps.map((a) => (
                    <button
                      key={a.bundleId + ":page"}
                      disabled={pending}
                      onClick={() => act("context.page", a.bundleId)}
                    >
                      {pending ? "读取中…" : `阅读 ${a.name} 当前网页`}
                    </button>
                  ))}
                  <small>
                    只在点击时读取已加载的可见正文，先预览再发送；不读取表单内容。
                  </small>
                </div>
              )}
              {(state.tabs || []).length > 0 && (
                <section
                  className="browser-tab-list"
                  aria-label="浏览器标签页列表"
                >
                  <div className="section-title">
                    <h2>
                      {state.tabs[0]?.name} 已打开标签页 ·{" "}
                      {state.tabWindowCount} 个窗口 / {state.tabs.length}{" "}
                      个标签页
                    </h2>
                  </div>
                  <input
                    aria-label="筛选标签页"
                    placeholder="按标题或网址筛选"
                    value={tabFilter}
                    onChange={(e) => setTabFilter(e.target.value)}
                  />
                  {tabs.map((tab) => (
                    <article
                      key={tab.bundleId + ":" + tab.windowId + ":" + tab.tabId}
                    >
                      <div>
                        <strong>{tab.title || "无标题"}</strong>
                        <small>
                          窗口 {tab.windowIndex}
                          {tab.active ? " · 该窗口选中的标签页" : ""}
                        </small>
                        <p>{tab.url || "浏览器内部页面或非 HTTP(S) 页面"}</p>
                      </div>
                      <button
                        disabled={pending || !tab.url}
                        onClick={() =>
                          act("context.page", {
                            bundleId: tab.bundleId,
                            windowId: tab.windowId,
                            tabId: tab.tabId,
                          })
                        }
                      >
                        读取此页正文
                      </button>
                    </article>
                  ))}
                  {state.tabsTruncated && (
                    <p>标签页过多，当前展示前 200 个。</p>
                  )}
                </section>
              )}
              {state.browser ? (
                <article className="tab-card">
                  <div className="tab-meta">
                    {state.browser.name} ·{" "}
                    {current ? "最近采样时位于前台" : "最近读取，当前不在前台"}{" "}
                    · {new Date(state.browser.observedAt).toLocaleTimeString()}
                  </div>
                  <h3>{state.browser.title || "无标题"}</h3>
                  <p>
                    {state.browser.url ||
                      "此标签页不是普通 HTTP(S) 网页，未展示地址。"}
                  </p>
                </article>
              ) : (
                <p className="awareness-hint">
                  {state.browserStatus === "no_tab"
                    ? "自动化接口没有返回窗口或标签页。请确认打开的是所选浏览器，并刷新；也可尝试下方窗口文字/OCR。"
                    : "尚未读取标签页。可切换到浏览器，或点击上方按钮读取。"}
                </p>
              )}
            </>
          )}
          <ApplicationContent apps={state.apps} enabled={state.enabled} />
        </>
      )}
      <div className="awareness-privacy">
        <h2>这一版能感知到什么</h2>
        <p>
          可列出运行应用和浏览器的现有标签页；点击应用读取按钮可读取窗口内容，点击标签页可读取该页正文。自动轮询不读取正文。OCR
          仅在点击时临时截取所选应用窗口，在本机识别后丢弃图像。网址会移除查询参数与片段；标题和路径仍可能包含私人信息，只在内存中保留最近一次结果。
        </p>
        <p>
          信息不写入数据库，也不会自动加入水獭聊天。隐私/无痕窗口未单独识别；不希望读取时请关闭浏览器感知。关闭应用感知同时关闭标签页读取并清空结果。
        </p>
      </div>
    </section>
  );
}
