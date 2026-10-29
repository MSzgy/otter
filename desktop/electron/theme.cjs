// The panel's colour theme. The renderer draws it; the main process only keeps
// the choice, tells macOS which appearance to use (native controls, scrollbars,
// the title bar) and paints the window behind the page in the theme's base.
const THEMES = ["warm", "mint", "bay", "night", "system"];
const BASE = {
  warm: "#fbf5ec",
  mint: "#eff7f2",
  bay: "#edf3fa",
  night: "#1d1713",
};

function normalizeTheme(value) {
  return THEMES.includes(value) ? value : "warm";
}
// nativeTheme.themeSource for a theme: only night is dark, only system follows.
function themeSource(theme) {
  const id = normalizeTheme(theme);
  return id === "system" ? "system" : id === "night" ? "dark" : "light";
}
// What the page will actually show; "system" depends on macOS's appearance.
function resolvedTheme(theme, dark) {
  const id = normalizeTheme(theme);
  return id === "system" ? (dark ? "night" : "warm") : id;
}
function windowColor(theme, dark) {
  return BASE[resolvedTheme(theme, dark)];
}
module.exports = {
  THEMES,
  normalizeTheme,
  themeSource,
  resolvedTheme,
  windowColor,
};
