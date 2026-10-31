import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import "./types";

type Device = {
  id: string;
  name: string;
  control: boolean;
  added: number;
  seen: number | null;
  online: boolean;
  stats: { p50: number; p95: number; rtt: number; n: number } | null;
};
type Mobile = {
  enabled: boolean;
  listening: boolean;
  port: number;
  name: string;
  addresses: string[];
  error: string;
  pairing: { link: string; expires: number; paired: string | null } | null;
  devices: Device[];
};

const api = window.otter;
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);
}
const when = (t: number | null) =>
  t
    ? new Date(t).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "还没连过";

// The pairing link as a QR code, drawn as one SVG path so it stays sharp.
function QrCode({ text }: { text: string }) {
  const { size, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, d: path };
  }, [text]);
  return (
    <svg
      className="mobile-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="配对二维码"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#1d1713" />
    </svg>
  );
}

// 设置 → 手机: let paired phones follow this desktop over the local network.
export function MobilePane() {
  const [state, setState] = useState<Mobile | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  async function run(name: string, value?: unknown) {
    setError("");
    try {
      setState(await api.action<Mobile>(name, value));
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    void run("mobile.get");
    return api.subscribe((event) => {
      if (event.type === "mobile.changed") setState(event.data);
    });
  }, []);
  const pairing = state?.pairing;
  useEffect(() => {
    if (!pairing || pairing.paired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing?.link, pairing?.paired]);
  if (!state) return error ? <p className="alert">{error}</p> : null;
  const left = pairing ? Math.max(0, pairing.expires - now) : 0;
  return (
    <>
      <section className="settings-section" aria-label="手机连接">
        <div className="setting-row">
          <div>
            <h2>允许手机连接</h2>
            <p>
              配对过的 iPhone 在同一个 Wi-Fi 下能看到这里的今天、聊天、Codex
              任务和水獭状态，变化实时推过去；打开“可以操作”的手机还能发消息、确认卡片、停止任务、勾待办。所有内容端到端加密；应用感知、窗口内容、剪贴板和密码不会同步。
            </p>
          </div>
          <input
            aria-label="允许手机连接"
            className="toggle"
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => {
              // Flip at once; the Mac's answer settles it.
              const enabled = e.target.checked;
              setState({ ...state, enabled });
              void run("mobile.enable", enabled);
            }}
          />
        </div>
        {state.enabled && (
          <p className="card-note">
            {state.listening
              ? `正在等手机连接：${state.addresses.join("、") || "没找到局域网地址"}，端口 ${state.port}`
              : state.error || "正在开启…"}
          </p>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </section>
      {state.listening && (
        <section className="settings-section" aria-label="我的手机">
          <div className="setting-row">
            <div>
              <h2>我的手机</h2>
              <p>用 iPhone 上的 Otter 扫码配对；一台手机配一次就行。</p>
            </div>
            {!pairing || pairing.paired || left === 0 ? (
              <button
                className="chat-new"
                onClick={() => void run("mobile.pair")}
              >
                添加手机
              </button>
            ) : (
              <button
                className="chat-link"
                onClick={() => void run("mobile.cancel")}
              >
                取消
              </button>
            )}
          </div>
          {pairing && !pairing.paired && left > 0 && (
            <div className="mobile-pair">
              <QrCode text={pairing.link} />
              <div>
                <strong>用 iPhone 上的 Otter 扫这个码</strong>
                <p className="card-note">
                  也可以用相机扫，会打开 Otter。{Math.ceil(left / 1000)}{" "}
                  秒内有效，只能用一次。
                </p>
                <button
                  onClick={() =>
                    void navigator.clipboard.writeText(pairing.link)
                  }
                >
                  复制配对链接
                </button>
              </div>
            </div>
          )}
          {pairing?.paired && (
            <p className="ssh-result ok" role="status">
              已配对：{pairing.paired}
            </p>
          )}
          {!state.devices.length && !pairing && (
            <p className="card-empty">还没有配对的手机。</p>
          )}
          {state.devices.map((d) => (
            <article
              key={d.id}
              className="ssh-host"
              aria-label={`手机：${d.name}`}
            >
              <div className="setting-line">
                <span>
                  <strong>{d.name}</strong>
                  <small>
                    {d.online
                      ? d.stats
                        ? `在线 · 延迟中位 ${Math.round(d.stats.p50)} ms，95% ≤ ${Math.round(d.stats.p95)} ms · 往返 ${Math.round(d.stats.rtt)} ms`
                        : "在线"
                      : `上次连接 ${when(d.seen)}`}
                    {` · ${when(d.added)} 配对`}
                  </small>
                </span>
                <span className="ssh-actions">
                  <label className="mobile-control">
                    <input
                      type="checkbox"
                      className="toggle"
                      aria-label={`${d.name} 可以操作`}
                      checked={d.control}
                      onChange={(e) => {
                        const control = e.target.checked;
                        setState({
                          ...state,
                          devices: state.devices.map((x) =>
                            x.id === d.id ? { ...x, control } : x,
                          ),
                        });
                        void run("mobile.control", { id: d.id, control });
                      }}
                    />
                    可以操作
                  </label>
                  <span className={`agent-badge ${d.online ? "ok" : ""}`}>
                    {d.online ? "在线" : "离线"}
                  </span>
                  <button
                    className="chat-link"
                    aria-label={`撤销 ${d.name}`}
                    onClick={() => void run("mobile.revoke", { id: d.id })}
                  >
                    撤销
                  </button>
                </span>
              </div>
            </article>
          ))}
          <p className="card-note">
            目前只在同一个局域网里直连；在外面也能看，之后会通过你自己服务器上的加密中继接上。
          </p>
        </section>
      )}
    </>
  );
}
