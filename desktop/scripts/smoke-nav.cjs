// The panel has three places, the otter's own page and a settings sheet. Steps
// below still name the sections they were written against; this maps them.
const SETTINGS_GROUPS = {
  偏好设置: "通用",
  应用感知: "隐私与感知",
  "AI 交接": "AI 交接",
};
const PLACES = {
  生活助手: "今天",
  工作简报: "今天",
  与水獭聊天: "聊天",
  项目与进度: "项目",
  陪伴互动: "我的水獭",
  记忆与个性: "我的水獭",
};
async function go(page, section) {
  const sheet = page.getByRole("dialog", { name: "设置" });
  const open = await sheet.isVisible().catch(() => false);
  const group = SETTINGS_GROUPS[section];
  if (group) {
    if (!open)
      await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: group, exact: false })
      .click();
    return;
  }
  if (open) await page.getByRole("button", { name: "关闭设置" }).click();
  await page
    .getByRole("button", { name: PLACES[section], exact: true })
    .click();
}
// Work scenes sit collapsed at the foot of 项目; opening links or apps in
// 今天's collapsed "打开网页或应用".
async function openDetails(page, place, selector) {
  await go(page, place);
  await page.locator(selector).evaluate((d) => {
    d.open = true;
  });
}
const openScenes = (page) =>
  openDetails(page, "项目与进度", "details.project-scenes");
const openTools = (page) => openDetails(page, "生活助手", "details.today-more");
module.exports = { go, openScenes, openTools };
