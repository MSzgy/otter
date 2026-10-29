const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTheme,
  themeSource,
  resolvedTheme,
  windowColor,
} = require("./theme.cjs");

test("unknown or missing themes fall back to 暖阳小窝", () => {
  for (const value of [undefined, null, "", "dark", 3, { id: "night" }])
    assert.equal(normalizeTheme(value), "warm");
  assert.equal(normalizeTheme("bay"), "bay");
});

test("only night forces dark and only system follows macOS", () => {
  assert.equal(themeSource("night"), "dark");
  assert.equal(themeSource("system"), "system");
  for (const theme of ["warm", "mint", "bay", "nonsense"])
    assert.equal(themeSource(theme), "light");
});

test("system resolves by appearance; the window base matches the page", () => {
  assert.equal(resolvedTheme("system", true), "night");
  assert.equal(resolvedTheme("system", false), "warm");
  assert.equal(resolvedTheme("mint", true), "mint");
  assert.equal(windowColor("system", true), "#1d1713");
  assert.equal(windowColor("system", false), "#fbf5ec");
  assert.equal(windowColor("bay", true), "#edf3fa");
});
