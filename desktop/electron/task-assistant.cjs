const { randomUUID } = require("node:crypto");
const { summary } = require("./extensions.cjs");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Values of env and headers in an MCP config: tokens, as a rule. They are
// blanked out of what the chat keeps, so later turns never send them on.
function secretsOf(config) {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value))
      if (["env", "headers"].includes(key) && item && typeof item === "object")
        for (const secret of Object.values(item))
          if (typeof secret === "string" && secret) found.push(secret);
          else walk(secret);
      else walk(item);
  };
  walk(config);
  return found.sort((a, b) => b.length - a.length);
}

class TaskAssistant {
  constructor({
    store,
    gate,
    interpret,
    record,
    projectAction = null,
    checkProject = null,
    scope = null,
    settings = null,
    extensions = null,
    timezone = () => "Asia/Shanghai",
    now = Date.now,
  }) {
    Object.assign(this, {
      store,
      gate,
      interpret,
      record,
      projectAction,
      checkProject,
      scope,
      settings,
      extensions,
      timezone,
      now,
    });
    this.generation = 0;
    this.pending = null;
    this.active = null;
    this.recent = new Map();
    this.receipts = new Map();
    // The last setting changed in each session, so its card can offer 撤销.
    this.lastSetting = new Map();
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
    this.lastSetting.delete(sessionId);
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
  state(sessionId, projectId) {
    const { reminders, todos: allTodos } = this.store.snapshot();
    const todos =
      projectId === undefined
        ? allTodos
        : allTodos.filter((t) => (t.projectId || "") === projectId);
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
      order(todos, (t) => !t.done).map(({ id, title, done, projectId }) => ({
        id,
        title,
        done,
        ...(projectId ? { projectId } : {}),
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
  async receipt(request, message, ok = true, extra = {}) {
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
    return { kind: "result", message, ok, warning, ...extra };
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
      const projectId = this.scope ? await this.scope(sessionId) : undefined;
      if (generation !== this.generation) return { kind: "cancelled" };
      const context = this.state(sessionId, projectId);
      if (this.settings) context.settings = await this.settings.rows();
      if (generation !== this.generation) return { kind: "cancelled" };
      let plan = await this.interpret({
        text: request.text,
        session_id: sessionId,
        state: context,
      });
      if (generation !== this.generation) return { kind: "cancelled" };
      if (plan.kind.startsWith("project_")) {
        if (!this.projectAction) throw new Error("项目功能尚未就绪。");
        plan = await this.projectAction(plan, request);
        if (generation !== this.generation) return { kind: "cancelled" };
        if (plan.kind === "capture") return plan;
        if (plan.kind === "result")
          return await this.receipt(request, plan.message);
      }
      if (plan.kind === "none") return { kind: "chat" };
      if (plan.kind === "clarify")
        return await this.receipt(request, `尚未执行操作。\n\n${plan.message}`);
      if (plan.kind === "setting_query") {
        if (!this.settings) throw new Error("设置尚未就绪。");
        const rows = context.settings || [];
        const row = plan.id && rows.find((r) => r.id === plan.id);
        if (plan.id && !row) throw new Error("这项设置不能在聊天里查看。");
        const line = (r) =>
          `${r.label}：${this.settings.format(r.id, r.current)}`;
        return await this.receipt(
          request,
          row
            ? `${line(row)}。`
            : `这些设置可以直接在聊天里改：\n\n${rows.map((r) => `• ${line(r)}`).join("\n\n")}\n\n模型、密钥和工作空间请到设置里手动改。`,
        );
      }
      if (["reminder_list", "todo_list"].includes(plan.kind)) {
        const snapshot = this.store.snapshot(),
          reminder = plan.kind === "reminder_list";
        let rows = reminder ? snapshot.reminders : snapshot.todos;
        if (!reminder && plan.project_id !== undefined)
          rows = rows.filter((r) => (r.projectId || "") === plan.project_id);
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
        const label = reminder ? "提醒" : plan.project_id ? "项目待办" : "待办";
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
        settingBefore,
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
          detail =
            (plan.projectName ? `项目：${plan.projectName}\n` : "") +
            plan.title;
          break;
        case "todo_complete":
          title = "确认完成待办";
          detail = target.title;
          break;
        case "setting_change": {
          if (!this.settings) throw new Error("设置尚未就绪。");
          const value = this.settings.validate(plan.id, plan.value);
          const { label } = this.settings.get(plan.id);
          settingBefore = await this.settings.read(plan.id);
          if (same(settingBefore, value))
            return await this.receipt(
              request,
              `${label}已经是${this.settings.format(plan.id, value)}，不用改。`,
            );
          plan = { ...plan, value };
          title = "确认更改设置";
          detail = `${label}：${this.settings.format(plan.id, settingBefore)} → ${this.settings.format(plan.id, value)}`;
          break;
        }
        case "mcp_add": {
          if (!this.extensions) throw new Error("工具与扩展尚未就绪。");
          for (const secret of secretsOf(plan.config))
            request.text = request.text.split(secret).join("••••");
          const config = JSON.stringify(plan.config);
          let servers;
          try {
            servers = this.extensions.preview(config);
          } catch (e) {
            return await this.receipt(request, `没有添加：${e.message}`);
          }
          title = "确认添加 MCP 服务";
          detail = summary(servers);
          plan = { ...plan, config, names: servers.map((s) => s.name) };
          break;
        }
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
        settingBefore,
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
      undo,
      ok = true;
    try {
      if (request.expiresAt < this.now())
        throw new Error("确认已过期，请重新发送要求。");
      const p = request.plan;
      if (p.project_ref) await this.checkProject(p.project_ref);
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
          const existed =
            p.sourceKey &&
            this.store
              .snapshot()
              .todos.some(
                (t) =>
                  t.projectId === p.projectId && t.sourceKey === p.sourceKey,
              );
          item = this.store.addTodo({
            title: p.title,
            projectId: p.projectId,
            sourceKey: p.sourceKey,
          });
          message = existed
            ? `${item.done ? "这条项目待办已经完成" : "已在本项目待办中"}：${item.title}`
            : `已添加待办：${item.title}`;
          break;
        case "todo_complete":
          item = this.store.completeTodo(p.id);
          message = `已完成待办：${item.title}`;
          break;
        case "mcp_add":
          this.extensions.add(p.config);
          message = `已添加 MCP 服务：${p.names.join("、")}。正在启动，好了以后它的工具就能在聊天里用；可以在 设置 → 工具与扩展 里管理。`;
          break;
        case "setting_change": {
          const { label } = this.settings.get(p.id);
          if (!same(await this.settings.read(p.id), request.settingBefore))
            throw new Error(`${label}刚刚被改过，请重新说一次。`);
          const after = await this.settings.write(p.id, p.value);
          message = `已把${label}改为${this.settings.format(p.id, after)}。`;
          undo = { id: p.id, label };
          this.lastSetting.set(sessionId, {
            id: p.id,
            before: request.settingBefore,
            after,
          });
          this.recent.set(sessionId, {
            id: p.id,
            kind: "setting",
            previous: request.settingBefore,
          });
          break;
        }
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
      const result = await this.receipt(
        request,
        message,
        ok,
        ok && undo ? { undo } : {},
      );
      this.receipts.set(id, { sessionId, result });
      if (this.receipts.size > 100)
        this.receipts.delete(this.receipts.keys().next().value);
      return result;
    } finally {
      this.executing = false;
    }
  }
  // 撤销 on a settings card: put the last chat change back, unless the setting
  // has moved on since (then nothing is changed).
  async undoSetting({ sessionId }) {
    if (this.executing) throw new Error("操作正在执行，请稍等。");
    const last = this.lastSetting.get(sessionId);
    if (!last || !this.settings) throw new Error("没有可以撤销的设置。");
    this.executing = true;
    try {
      const { label } = this.settings.get(last.id);
      if (!same(await this.settings.read(last.id), last.after))
        throw new Error(`${label}之后又被改过，没有撤销。`);
      const value = await this.settings.write(last.id, last.before);
      this.lastSetting.delete(sessionId);
      this.recent.set(sessionId, {
        id: last.id,
        kind: "setting",
        previous: last.after,
      });
      return await this.receipt(
        { id: randomUUID(), sessionId, text: "撤销刚才的设置" },
        `已撤销：${label}改回${this.settings.format(last.id, value)}。`,
      );
    } finally {
      this.executing = false;
    }
  }
}
module.exports = { TaskAssistant };
