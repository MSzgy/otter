import { useEffect, useRef, useState } from "react";
import type { Backdrop } from "./types";

const api = window.otter;
function message(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
    : String(e);
}

// Lays the picture behind the panel: <html data-backdrop> turns the layer on,
// two custom properties carry the picture and how much of it shows.
export function applyBackdrop(backdrop?: Backdrop | null) {
  const root = document.documentElement;
  if (backdrop?.current) {
    root.dataset.backdrop = "on";
    root.style.setProperty(
      "--backdrop-image",
      `url("${backdrop.current.url}")`,
    );
    root.style.setProperty(
      "--backdrop-opacity",
      String((100 - backdrop.transparency) / 100),
    );
  } else {
    delete root.dataset.backdrop;
    root.style.removeProperty("--backdrop-image");
    root.style.removeProperty("--backdrop-opacity");
  }
}

export function useBackdrop(backdrop?: Backdrop | null) {
  useEffect(() => applyBackdrop(backdrop), [backdrop]);
}

// 背景图片: pick a picture, set how see-through it is, switch back to one used
// before. The slider moves the picture at once and saves when it settles.
export function BackdropPicker({
  value,
  onChange,
}: {
  value: Backdrop | null | undefined;
  onChange: (next: Backdrop) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function run(name: string, arg?: unknown) {
    setError("");
    setBusy(true);
    try {
      onChange(await api.action<Backdrop>(name, arg));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const current = value?.current;
  const transparency = value?.transparency ?? 40;
  const others = (value?.recent || []).filter((r) => r.file !== current?.file);
  return (
    <section className="settings-section" aria-label="背景图片">
      <div className="setting-row">
        <div>
          <h2>背景图片</h2>
          <p>
            铺一张自己的图片在窗口后面。透明度越高，图片越淡、越透出主题底色。图片会复制一份存在
            Otter 里，原图挪走也不影响。
          </p>
        </div>
        <button
          className="chat-new"
          disabled={busy}
          onClick={() => void run("backdrop.pick")}
        >
          {busy ? "处理中…" : current ? "换一张…" : "选一张图片…"}
        </button>
      </div>
      {current && (
        <div className="backdrop-current">
          <span className="backdrop-preview" aria-hidden="true">
            <img
              src={current.url}
              alt=""
              style={{ opacity: (100 - transparency) / 100 }}
            />
          </span>
          <div className="backdrop-controls">
            <strong title={current.name}>{current.name}</strong>
            <label className="backdrop-slider">
              <span>透明度</span>
              <input
                type="range"
                min={0}
                max={95}
                step={5}
                aria-label="背景图透明度"
                value={transparency}
                style={
                  {
                    "--fill": `${(transparency / 95) * 100}%`,
                  } as React.CSSProperties
                }
                onChange={(e) => {
                  const next = Number(e.target.value);
                  onChange({ ...value!, transparency: next });
                  window.clearTimeout(timer.current);
                  timer.current = window.setTimeout(
                    () =>
                      void api
                        .action<Backdrop>("backdrop.transparency", next)
                        .catch((e) => setError(message(e))),
                    200,
                  );
                }}
              />
              <output>{transparency}%</output>
            </label>
            <button
              className="chat-link"
              disabled={busy}
              onClick={() => void run("backdrop.clear")}
            >
              不用背景图
            </button>
          </div>
        </div>
      )}
      {others.length > 0 && (
        <div className="backdrop-recent">
          <small>{current ? "用过的" : "用过的，点一下换回来"}</small>
          <ul aria-label="用过的背景图">
            {others.map((r) => (
              <li key={r.file}>
                <button
                  className="backdrop-thumb"
                  disabled={busy}
                  aria-label={`用 ${r.name} 做背景`}
                  title={r.name}
                  onClick={() => void run("backdrop.use", { file: r.file })}
                >
                  <img src={r.url} alt="" />
                </button>
                <button
                  className="backdrop-forget"
                  disabled={busy}
                  aria-label={`删除 ${r.name}`}
                  title="删除"
                  onClick={() => void run("backdrop.forget", { file: r.file })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
