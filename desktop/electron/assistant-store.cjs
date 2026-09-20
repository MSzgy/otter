const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
class AssistantStore {
  constructor(
    file,
    { now = Date.now, emit = () => {}, notify = () => {} } = {},
  ) {
    this.file = file;
    this.now = now;
    this.emit = emit;
    this.notify = notify;
    this.timer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(this.data.reminders)) throw new Error();
      this.data.todos ??= [];
      this.data.sessions ??= [];
      if (!Array.isArray(this.data.todos) || !Array.isArray(this.data.sessions))
        throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT" && fs.existsSync(file))
        throw new Error("生活助手数据无法读取，请保留文件并检查备份。");
      this.data = { reminders: [], todos: [], sessions: [] };
    }
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.data), {
      mode: 0o600,
    });
    fs.renameSync(this.file + ".tmp", this.file);
  }
  snapshot() {
    return structuredClone({
      reminders: this.data.reminders,
      todos: this.data.todos,
      sessions: this.data.sessions,
      focus:
        this.data.reminders.find(
          (r) => r.kind === "focus" && r.status === "pending",
        ) || null,
    });
  }
  publish() {
    this.emit(this.snapshot());
  }
  create(params) {
    if (
      typeof params.requestId !== "string" ||
      params.requestId.length > 80 ||
      !params.requestId
    )
      throw new Error("请求编号无效。");
    const prior = this.data.reminders.find(
      (r) => r.requestId === params.requestId,
    );
    if (prior) return { ...prior };
    const title = typeof params.title === "string" ? params.title.trim() : "";
    const dueAt = Number(params.dueAt),
      now = this.now();
    if (
      !title ||
      title.length > 200 ||
      !Number.isFinite(dueAt) ||
      dueAt <= now ||
      dueAt > now + 366 * 86400000
    )
      throw new Error("请填写提醒内容和一年以内的未来时间。");
    const kind = params.kind === "focus" ? "focus" : "reminder";
    if (kind === "focus" && this.snapshot().focus)
      throw new Error("已有专注计时，请先结束或取消。");
    if (this.data.reminders.length >= 500)
      throw new Error("提醒记录已满，请清理已完成记录。");
    const reminder = {
      id: randomUUID(),
      requestId: params.requestId,
      title,
      kind,
      dueAt,
      status: "pending",
      createdAt: now,
      notifiedAt: null,
    };
    this.data.reminders.unshift(reminder);
    try {
      this.persist();
    } catch (e) {
      this.data.reminders.shift();
      throw e;
    }
    this.publish();
    return { ...reminder };
  }
  change(id, status) {
    if (!["cancelled", "done"].includes(status))
      throw new Error("提醒操作无效。");
    const reminder = this.data.reminders.find((r) => r.id === id);
    if (!reminder) throw new Error("提醒不存在。");
    const old = reminder.status;
    reminder.status = status;
    try {
      this.persist();
    } catch (e) {
      reminder.status = old;
      throw e;
    }
    this.publish();
    return this.snapshot();
  }
  clearFinished() {
    const old = this.data.reminders;
    this.data.reminders = old.filter((r) =>
      ["pending", "due"].includes(r.status),
    );
    try {
      this.persist();
    } catch (e) {
      this.data.reminders = old;
      throw e;
    }
    this.publish();
    return this.snapshot();
  }
  addTodo(params) {
    const title = typeof params.title === "string" ? params.title.trim() : "";
    if (!title || title.length > 200)
      throw new Error("待办内容应为 1–200 字。");
    if (this.data.todos.length >= 500)
      throw new Error("待办记录已满，请先清理。");
    const item = {
      id: randomUUID(),
      title,
      done: false,
      createdAt: this.now(),
    };
    this.data.todos.unshift(item);
    try {
      this.persist();
    } catch (e) {
      this.data.todos.shift();
      throw e;
    }
    this.publish();
    return item;
  }
  changeTodo(id, remove) {
    const old = structuredClone(this.data.todos);
    const item = this.data.todos.find((x) => x.id === id);
    if (!item) throw new Error("待办不存在。");
    if (remove) this.data.todos = this.data.todos.filter((x) => x.id !== id);
    else item.done = !item.done;
    try {
      this.persist();
    } catch (e) {
      this.data.todos = old;
      throw e;
    }
    this.publish();
    return this.snapshot();
  }
  saveSession(params) {
    const values = {};
    for (const [key, limit] of Object.entries({
      title: 160,
      context: 18000,
      question: 2000,
      nextStep: 2000,
    })) {
      if (typeof params[key] !== "string" || params[key].length > limit)
        throw new Error("工作现场字段格式或长度不正确。");
      values[key] = params[key].trim();
    }
    if (!values.title || !values.nextStep)
      throw new Error("请填写名称和下一步。");
    if (this.data.sessions.length >= 100)
      throw new Error("已保存 100 个工作现场，请删除不再需要的记录。");
    const item = { id: randomUUID(), ...values, createdAt: this.now() };
    this.data.sessions.unshift(item);
    try {
      this.persist();
    } catch (e) {
      this.data.sessions.shift();
      throw e;
    }
    this.publish();
    return item;
  }
  getSession(id) {
    const item = this.data.sessions.find((x) => x.id === id);
    if (!item) throw new Error("工作现场不存在。");
    return { ...item };
  }
  deleteSession(id) {
    const old = this.data.sessions;
    this.data.sessions = old.filter((x) => x.id !== id);
    try {
      this.persist();
    } catch (e) {
      this.data.sessions = old;
      throw e;
    }
    this.publish();
    return this.snapshot();
  }
  tick() {
    const now = this.now();
    const due = this.data.reminders.filter(
      (r) => r.status === "pending" && r.dueAt <= now,
    );
    if (!due.length) return;
    for (const r of due) {
      r.status = "due";
      r.notifiedAt = now;
    }
    try {
      this.persist();
    } catch {
      for (const r of due) {
        r.status = "pending";
        r.notifiedAt = null;
      }
      return;
    }
    this.publish();
    // Persist before emitting, so restarts cannot repeatedly notify the same reminder.
    const late = due.some((r) => now - r.dueAt > 60000);
    try {
      this.notify({
        title:
          due.length === 1
            ? due[0].kind === "focus"
              ? "专注结束"
              : "提醒时间到了"
            : `${due.length} 条提醒已到时间`,
        body:
          due.length === 1
            ? due[0].title
            : `${late ? "离开期间到期的提醒" : "到期提醒"}：${due
                .slice(0, 3)
                .map((r) => r.title)
                .join("；")}${due.length > 3 ? "…" : ""}`,
        late,
      });
    } catch {
      /* The due reminder remains visible even if the OS notification fails. */
    }
  }
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }
  close() {
    clearInterval(this.timer);
  }
}
module.exports = { AssistantStore };
