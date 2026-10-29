// Settings the chat may read and change. main.cjs supplies each entry's read
// and write, and the writes go through the same actions as the settings sheet,
// so a change made in chat is the same change as one made by hand. The model,
// its key, the workspace and the AI-handoff switch are deliberately absent: they
// stay manual.
class SettingsRegistry {
  constructor(definitions) {
    this.items = new Map(definitions.map((d) => [d.id, d]));
  }
  has(id) {
    return this.items.has(id);
  }
  get(id) {
    const item = this.items.get(id);
    if (!item) throw new Error("这项设置不能在聊天里改。");
    return item;
  }
  // The value a setting may take, or an error; the planner is checked again here.
  validate(id, value) {
    const item = this.get(id);
    if (item.type === "switch" && typeof value === "boolean") return value;
    if (item.type === "choice" && item.options.some((o) => o.value === value))
      return value;
    if (
      item.type === "number" &&
      Number.isInteger(value) &&
      value >= item.min &&
      value <= item.max
    )
      return value;
    if (
      item.type === "text" &&
      typeof value === "string" &&
      value.trim() &&
      value.trim().length <= item.max
    )
      return value.trim();
    throw new Error(`${item.label}不能设成这个值。`);
  }
  format(id, value) {
    const item = this.get(id);
    if (item.type === "switch") return value ? "开" : "关";
    if (item.type === "choice")
      return (
        item.options.find((o) => o.value === value)?.label ?? String(value)
      );
    if (item.type === "number") return `${value}${item.unit || ""}`;
    return value ? `“${value}”` : "未设置";
  }
  async read(id) {
    return this.get(id).read();
  }
  // Rows for the planner: what can be changed, how, and what it is now. An
  // entry whose read fails (its part of the app is not ready) is left out.
  async rows() {
    const rows = [];
    for (const item of this.items.values()) {
      let current;
      try {
        current = await item.read();
      } catch {
        continue;
      }
      const { id, label, type, options, min, max, unit } = item;
      rows.push({
        id,
        label,
        type,
        ...(options ? { options } : {}),
        ...(type === "number" ? { min, max, unit } : {}),
        ...(type === "text" ? { max } : {}),
        current,
      });
    }
    return rows;
  }
  async write(id, value) {
    const item = this.get(id);
    await item.write(this.validate(id, value));
    return item.read();
  }
}
module.exports = { SettingsRegistry };
