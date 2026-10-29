import { useEffect } from "react";
import "./themes.css";

export type ThemeId = "warm" | "mint" | "bay" | "night" | "system";

// Each swatch shows the theme's own background, card and accent, so it reads
// the same whichever theme is on.
export const THEMES: {
  id: ThemeId;
  label: string;
  note: string;
  colors: [string, string, string];
}[] = [
  {
    id: "warm",
    label: "暖阳小窝",
    note: "奶油底，水獭橘",
    colors: ["#fbf5ec", "#ffffff", "#e8743f"],
  },
  {
    id: "mint",
    label: "薄荷清晨",
    note: "清爽的浅绿",
    colors: ["#eff7f2", "#ffffff", "#2f9e78"],
  },
  {
    id: "bay",
    label: "海湾蓝",
    note: "安静的蓝",
    colors: ["#edf3fa", "#ffffff", "#3a7bd5"],
  },
  {
    id: "night",
    label: "夜里小窝",
    note: "深色，晚上不刺眼",
    colors: ["#1d1713", "#2f2621", "#f08a50"],
  },
  {
    id: "system",
    label: "跟随系统",
    note: "白天暖阳，夜里深色",
    colors: ["#fbf5ec", "#1d1713", "#e8743f"],
  },
];

export function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

// "system" follows macOS: 暖阳小窝 by day, 夜里小窝 in dark mode.
function resolve(theme: ThemeId, dark: boolean) {
  return theme === "system" ? (dark ? "night" : "warm") : theme;
}

export function applyTheme(theme: unknown) {
  const id = isTheme(theme) ? theme : "warm";
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = resolve(id, dark);
}

// Keeps <html data-theme> in step with the setting and, for "system", with macOS.
export function useTheme(theme: unknown) {
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyTheme(theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
}) {
  return (
    <section className="settings-section">
      <h2>外观</h2>
      <p>换一身颜色，桌面水獭的气泡也会跟着变。</p>
      <div className="theme-picker" role="radiogroup" aria-label="主题">
        {THEMES.map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={value === t.id}
            aria-label={t.label}
            className={value === t.id ? "selected" : ""}
            onClick={() => onChange(t.id)}
          >
            <span
              className="theme-swatch"
              style={{
                background:
                  t.id === "system"
                    ? `linear-gradient(135deg, ${t.colors[0]} 50%, ${t.colors[1]} 50%)`
                    : t.colors[0],
              }}
            >
              {t.id !== "system" && (
                <i style={{ background: t.colors[1] }} aria-hidden="true" />
              )}
              <b style={{ background: t.colors[2] }} aria-hidden="true" />
            </span>
            <strong>{t.label}</strong>
            <small>{t.note}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
