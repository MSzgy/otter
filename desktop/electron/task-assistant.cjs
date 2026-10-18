const { randomUUID } = require("node:crypto");

class TaskAssistant {
  constructor({
    store,
    gate,
    interpret,
    record,
    timezone = () => "Asia/Shanghai",
    now = Date.now,
  }) {
    Object.assign(this, { store, gate, interpret, record, timezone, now });
    this.generation = 0;
    this.pending = null;
    this.active = null;
    this.recent = new Map();
    this.receipts = new Map();
    this.executing = false;
  }
  get busy() {
    return !!this.active || this.executing;
  }
  invalidate() {
    this.generation++;
    if (this.pending?.gateId) this.gate.cancel(this.pending.gateId);
    this.pending = null;
    this.active = null;
  }
  cancel(requestId) {
    if (
      this.active?.requestId === requestId ||
      this.pending?.requestId === requestId
    )
      this.invalidate();
  }
  forget(sessionId) {
    if (
      this.active?.sessionId === sessionId ||
      this.pending?.sessionId === sessionId
    )
      this.invalidate();
    this.recent.delete(sessionId);
  }
  date(value) {
    return (
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: this.timezone(),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(value) + `（${this.timezone()}）`
    );
  }
  state(sessionId) {
    const { reminders, todos } = this.store.snapshot();
    const recent = this.recent.get(sessionId);
    const order = (rows, isActive) =>
      [...rows]
        .sort(
          (a, b) =>
            Number(b.id === recent?.id) - Number(a.id === recent?.id) ||
            Number(isActive(b)) - Number(isActive(a)),
        )
        .slice(0, 60);
    const bounded = (rows) => {
      let bytes = 0;
      return rows.filter((row) => {
        bytes += Buffer.byteLength(JSON.stringify(row));
        return bytes <= 12000;
      });
    };
    const reminderRows = bounded(
      order(reminders, (r) => ["pending", "due"].includes(r.status)).map(
        ({ id, title, dueAt, status }) => ({ id, title, dueAt, status }),
      ),
    );
    const todoRows = bounded(
      order(todos, (t) => !t.done).map(({ id, title, done }) => ({
        id,
        title,
        done,
      })),
    );
    return {
      reminders: reminderRows,
      todos: todoRows,
      recent_target: recent || null,
      truncated:
        reminders.length > reminderRows.length ||
        todos.length > todoRows.length,
    };
  }
  async receipt(request, message, ok = true) {
    let warning = "";
    try {
      await this.record({
        session_id: request.sessionId,
        request_id: request.id,
        text: request.text,
        result: message,
      });
    } catch {
      warning = "本次结果未能写入聊天记录，请以生活助手列表为准。";
    }
    return { kind: "result", message, ok, warning };
  }
  async plan({ text, sessionId, requestId }) {
    if (this.executing) throw new Error("正在执行上一项操作，请稍等。");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 6000 ||
      typeof sessionId !== "string" ||
      !sessionId ||
      typeof requestId !== "string" ||
      requestId.length > 80
    )
      throw new Error("办事请求无效。");
    this.invalidate();
    const generation = this.generation;
    const request = {
      id: randomUUID(),
      text: text.trim(),
      sessionId,
      requestId,
    };
    this.active = request;
    try {
      const context = this.state(sessionId);
      const plan = await this.interpret({
        text: request.text,
        session_id: sessionId,
        state: context,
      });
      if (generation !== this.generation) return { kind: "cancelled" };
      if (plan.kind === "none") return { kind: "chat" };
      if (plan.kind === "clarify")
        return await this.receipt(request, `尚未执行操作。\n\n${plan.message}`);
      if (["reminder_list", "todo_list"].includes(plan.kind)) {
        const snapshot = this.store.snapshot(),
          reminder = plan.kind === "reminder_list";
        let rows = reminder ? snapshot.reminders : snapshot.todos;
        rows = rows.filter(
          (r) =>
            plan.status === "all" ||
            (plan.status === "done"
              ? reminder
                ? ["done", "cancelled"].includes(r.status)
                : r.done
              : reminder
                ? ["pending", "due"].includes(r.status)
                : !r.done),
        );
        if (reminder && plan.date)
          rows = rows.filter(
            (r) =>
              new Intl.DateTimeFormat("en-CA", {
                timeZone: this.timezone(),
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(r.dueAt) === plan.date,
          );
        const label = reminder ? "提醒" : "待办";
        const status = {
          pending: "等待提醒",
          due: "已到时间",
          cancelled: "已取消",
          done: "已完成",
        };
        const lines = rows
          .slice(0, 40)
          .map((r) =>
            reminder
              ? `• ${r.title} · ${this.date(r.dueAt)} · ${status[r.status]}`
              : `• ${r.title} · ${r.done ? "已完成" : "未完成"}`,
          );
        return await this.receipt(
          request,
          `本机${label}：共 ${rows.length} 条${plan.date ? `（${plan.date}）` : ""}${lines.length ? "\n\n" + lines.join("\n\n") : "。"}${rows.length > 40 ? "\n\n这里只展示前 40 条，其余请在生活助手查看。" : ""}`,
        );
      }
      const snapshot = this.store.snapshot();
      let title,
        detail,
        target = null,
        gateId;
      if (
        ["reminder_update", "reminder_cancel", "todo_complete"].includes(
          plan.kind,
        )
      ) {
        target = (
          plan.kind === "todo_complete" ? snapshot.todos : snapshot.reminders
        ).find((r) => r.id === plan.id);
        if (!target) throw new Error("目标已不存在，请重新描述要求。");
        const group = plan.kind === "todo_complete" ? "todos" : "reminders";
        const expected = context[group].find((r) => r.id === plan.id);
        if (
          !expected ||
          Object.keys(expected).some((key) => expected[key] !== target[key])
        )
          throw new Error("理解期间这条记录已变化，请重新发送要求。");
        if (
          plan.kind !== "todo_complete" &&
          !["pending", "due"].includes(target.status)
        )
          throw new Error("提醒已经结束，请重新查询。");
      }
      switch (plan.kind) {
        case "reminder_create":
          title = "确认创建本机提醒";
          detail = `${plan.title} · ${this.date(plan.dueAt)}`;
          break;
        case "reminder_update":
          title = "确认修改提醒";
          detail = `原提醒：${target.title} · ${this.date(target.dueAt)}\n修改为：${plan.title ?? target.title} · ${this.date(plan.dueAt ?? target.dueAt)}`;
          break;
        case "reminder_cancel":
          title = "确认取消提醒";
          detail = `${target.title} · ${this.date(target.dueAt)}`;
          break;
        case "todo_add":
          title = "确认添加待办";
          detail = plan.title;
          break;
        case "todo_complete":
          title = "确认完成待办";
          detail = target.title;
          break;
        case "open_app":
        case "open_url": {
          const action = await this.gate.prepare(plan);
          gateId = action.id;
          title = `确认${action.label}`;
          detail = action.description;
          break;
        }
        default:
          throw new Error("暂不支持这项操作。");
      }
      if (generation !== this.generation) {
        if (gateId) this.gate.cancel(gateId);
        return { kind: "cancelled" };
      }
      this.pending = {
        ...request,
        plan,
        target,
        gateId,
        title,
        detail,
        expiresAt: this.now() + 60000,
      };
      return {
        kind: "proposal",
        id: request.id,
        title,
        detail,
        action: plan.kind,
        expiresAt: this.pending.expiresAt,
      };
    } finally {
      if (generation === this.generation) this.active = null;
    }
  }
  async confirm({ id, sessionId }) {
    const prior = this.receipts.get(id);
    if (prior?.sessionId === sessionId) return prior.result;
    if (this.executing) throw new Error("操作正在执行，请稍等。");
    const request = this.pending;
    if (!request || request.id !== id || request.sessionId !== sessionId)
      throw new Error("请重新发送要求并确认。");
    this.pending = null;
    this.executing = true;
    let message,
      ok = true;
    try {
      if (request.expiresAt < this.now())
        throw new Error("确认已过期，请重新发送要求。");
      const p = request.plan;
      if (request.target) {
        const snapshot = this.store.snapshot();
        const current = (
          p.kind === "todo_complete" ? snapshot.todos : snapshot.reminders
        ).find((r) => r.id === p.id);
        if (JSON.stringify(current) !== JSON.stringify(request.target))
          throw new Error("这条记录已变化，请重新查询并确认。");
      }
      let item;
      switch (p.kind) {
        case "reminder_create":
          item = this.store.create({
            title: p.title,
            dueAt: p.dueAt,
            requestId: request.id,
          });
          message = `已创建提醒：${item.title} · ${this.date(item.dueAt)}`;
          break;
        case "reminder_update":
          item = this.store.updateReminder(p.id, p);
          message = `已修改提醒：${item.title} · ${this.date(item.dueAt)}`;
          break;
        case "reminder_cancel":
          this.store.change(p.id, "cancelled");
          item = request.target;
          message = `已取消提醒：${item.title}`;
          break;
        case "todo_add":
          item = this.store.addTodo({ title: p.title });
          message = `已添加待办：${item.title}`;
          break;
        case "todo_complete":
          item = this.store.completeTodo(p.id);
          message = `已完成待办：${item.title}`;
          break;
        case "open_app":
        case "open_url":
          message =
            (await this.gate.confirm(request.gateId)).message +
            `\n${request.detail}`;
          break;
        default:
          throw new Error("不支持这个操作。");
      }
      if (item)
        this.recent.set(sessionId, {
          id: item.id,
          kind: p.kind.startsWith("todo") ? "todo" : "reminder",
        });
      if (this.recent.size > 100)
        this.recent.delete(this.recent.keys().next().value);
    } catch (e) {
      ok = false;
      message = `操作未完成：${e.code ? "本机保存失败，请检查可用空间后重试。" : e.message}`;
    }
    if (request.gateId) this.gate.cancel(request.gateId);
    try {
      const result = await this.receipt(request, message, ok);
      this.receipts.set(id, { sessionId, result });
      if (this.receipts.size > 100)
        this.receipts.delete(this.receipts.keys().next().value);
      return result;
    } finally {
      this.executing = false;
    }
  }
}
module.exports = { TaskAssistant };
