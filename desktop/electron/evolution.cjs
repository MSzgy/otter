(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OtterEvolution = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const FORMS = ["companion", "artisan", "deep"];
  const EVOLVE_MS = 640,
    CINEMATIC_MS = 2400,
    RESULT_MS = 1400;
  // In auto mode, artisan work that keeps going this long dives into the deep
  // form. Only working time counts: time spent waiting for the user does not.
  const DEEP_AFTER_MS = 20000;
  const TRANSITIONS = ["cinematic", "quick", "none"];
  const transitionMs = (style) =>
    style === "none" ? 0 : style === "cinematic" ? CINEMATIC_MS : EVOLVE_MS;
  const LABELS = {
    companion: "陪伴形态",
    artisan: "工匠形态",
    deep: "深潜形态",
  };
  const safeId = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 160;
  function chooseForm(task = {}, mode = "auto") {
    if (["artisan", "deep"].includes(mode)) return mode;
    if (["high", "xhigh", "max", "ultra"].includes(task.effort)) return "deep";
    if (Number.isFinite(task.plannedSteps) && task.plannedSteps >= 4)
      return "deep";
    if (["low", "minimal", "none"].includes(task.effort)) return "companion";
    if (
      task.source === "chat" &&
      task.effort !== "medium" &&
      !(Number.isFinite(task.plannedSteps) && task.plannedSteps >= 2)
    )
      return "companion";
    return "artisan";
  }
  class EvolutionMachine {
    constructor({
      schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
      cancel = (timer) => globalThis.clearTimeout(timer),
      now = Date.now,
      changed = () => {},
    } = {}) {
      this.schedule = schedule;
      this.cancelTimer = cancel;
      this.now = now;
      this.changed = changed;
      this.epoch = 0;
      this.timers = new Set();
      this.state = this.idle();
    }
    idle() {
      return {
        form: "companion",
        phase: "idle",
        from: "companion",
        task: null,
        caption: "我在这里，陪你慢慢来。",
        transitionStyle: "none",
        transitionDurationMs: 0,
        changedAt: this.now(),
      };
    }
    snapshot() {
      return {
        ...this.state,
        task: this.state.task ? { ...this.state.task } : null,
      };
    }
    invalidate() {
      this.epoch++;
      for (const timer of this.timers) this.cancelTimer(timer);
      this.timers.clear();
    }
    after(ms, callback) {
      const epoch = this.epoch;
      const timer = this.schedule(() => {
        this.timers.delete(timer);
        if (epoch === this.epoch) callback();
      }, ms);
      this.timers.add(timer);
    }
    emit() {
      this.state.changedAt = this.now();
      this.changed(this.snapshot());
    }
    start(task) {
      if (!safeId(task.id) || !FORMS.includes(task.form))
        throw new Error("任务形态无效。");
      const from = this.state.form;
      const transitionStyle = TRANSITIONS.includes(task.transition)
        ? task.transition
        : "quick";
      const duration = transitionMs(transitionStyle);
      this.invalidate();
      this.state = {
        form: task.form,
        phase:
          from === "companion" && task.form !== "companion" && duration > 0
            ? "evolving"
            : "working",
        from,
        transitionStyle,
        transitionDurationMs: duration,
        task: { id: task.id, source: task.source, label: task.label },
        caption: task.label || "开始认真处理这件事。",
        changedAt: this.now(),
      };
      this.emit();
      if (this.state.phase === "evolving")
        this.after(duration, () => {
          this.state.phase = "working";
          this.emit();
        });
      return this.snapshot();
    }
    skipTransition() {
      if (this.state.phase === "evolving") {
        this.invalidate();
        this.state.phase = "working";
        this.emit();
        return true;
      }
      if (this.state.phase === "returning") {
        this.reset();
        return true;
      }
      return false;
    }
    waiting(id) {
      if (this.state.task?.id !== id) return false;
      this.invalidate();
      this.state.phase = "waiting";
      this.state.caption = "等你在原来的面板里决定。";
      this.emit();
      return true;
    }
    resume(id) {
      if (this.state.task?.id !== id) return false;
      this.invalidate();
      this.state.phase = "working";
      this.state.caption = "收到，继续处理。";
      this.emit();
      return true;
    }
    finish(id, ok, caption) {
      if (
        this.state.task?.id !== id ||
        ["success", "error", "returning", "idle"].includes(this.state.phase)
      )
        return false;
      this.invalidate();
      this.state.phase = ok ? "success" : "error";
      this.state.caption =
        caption || (ok ? "这一步已经完成。" : "这里遇到问题，需要再看看。");
      this.emit();
      this.after(RESULT_MS, () => {
        if (
          this.state.form === "companion" ||
          this.state.transitionStyle === "none"
        ) {
          this.state = this.idle();
          this.emit();
          return;
        }
        this.state.phase = "returning";
        this.state.from = this.state.form;
        this.state.caption = "收好工具，回到你身边。";
        this.emit();
        this.after(EVOLVE_MS, () => {
          this.state = this.idle();
          this.emit();
        });
      });
      return true;
    }
    reset() {
      this.invalidate();
      this.state = this.idle();
      this.emit();
    }
    close() {
      this.invalidate();
    }
  }
  class EvolutionController {
    constructor({
      schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
      cancel = (timer) => globalThis.clearTimeout(timer),
      now = Date.now,
      changed = () => {},
      persist = () => {},
    } = {}) {
      this.now = now;
      this.schedule = schedule;
      this.cancelTimer = cancel;
      this.changed = changed;
      this.persist = persist;
      this.settings = { enabled: true, mode: "auto", transition: "cinematic" };
      this.milestones = [];
      this.lastCompleted = null;
      this.activities = new Map();
      this.dives = new Map(); // source -> { timer, worked, since }
      this.demoTimers = new Set();
      this.demoRevision = 0;
      this.demoInfo = null;
      this.live = new EvolutionMachine({
        schedule,
        cancel,
        now,
        changed: () => this.emit(),
      });
      this.demo = new EvolutionMachine({
        schedule,
        cancel,
        now,
        changed: () => this.onDemoChanged(),
      });
    }
    snapshot() {
      return {
        settings: { ...this.settings },
        live: this.live.snapshot(),
        demo: this.demoInfo
          ? {
              ...this.demo.snapshot(),
              stage: this.demoInfo.stage,
              running: true,
            }
          : null,
        lastCompleted: this.lastCompleted ? { ...this.lastCompleted } : null,
        milestones: this.milestones.map((item) => ({ ...item })),
      };
    }
    emit() {
      try {
        this.changed(this.snapshot());
      } catch {}
    }
    onDemoChanged() {
      if (
        this.demoInfo?.stage === "starting" &&
        this.demo.state.phase === "working"
      ) {
        this.demoInfo.stage = "working";
        this.laterDemo(1300, () => {
          if (!this.demoInfo) return;
          this.demoInfo.stage = "waiting";
          this.demo.waiting(this.demoInfo.id);
        });
      }
      if (
        this.demoInfo &&
        ["finished", "blocked"].includes(this.demoInfo.stage) &&
        this.demo.state.phase === "idle"
      )
        this.demoInfo = null;
      this.emit();
    }
    restore(saved = {}) {
      if (!saved || typeof saved !== "object" || Array.isArray(saved))
        saved = {};
      this.settings = {
        enabled: saved.enabled !== false,
        transition: TRANSITIONS.includes(saved.transition)
          ? saved.transition
          : "cinematic",
        mode: ["auto", "artisan", "deep"].includes(saved.mode)
          ? saved.mode
          : "auto",
      };
      const seen = new Set();
      this.milestones = (
        Array.isArray(saved.milestones) ? saved.milestones : []
      )
        .filter(
          (item) =>
            item &&
            safeId(item.id) &&
            ["report", "task"].includes(item.kind) &&
            Number.isFinite(item.createdAt) &&
            !seen.has(item.id) &&
            (seen.add(item.id), true),
        )
        .slice(-20)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          title:
            item.kind === "report"
              ? "共同完成一份工作简报"
              : "共同完成一次确认操作",
          createdAt: item.createdAt,
        }));
      this.emit();
    }
    persisted(settings = this.settings, milestones = this.milestones) {
      return {
        ...settings,
        milestones: milestones.map((item) => ({ ...item })),
      };
    }
    configure(value) {
      if (
        !value ||
        typeof value.enabled !== "boolean" ||
        !["auto", "artisan", "deep"].includes(value.mode)
      )
        throw new Error("进化设置无效。");
      const transition =
        value.transition === undefined
          ? this.settings.transition
          : value.transition;
      if (!TRANSITIONS.includes(transition))
        throw new Error("进化演出设置无效。");
      const next = { enabled: value.enabled, mode: value.mode, transition };
      this.persist(this.persisted(next));
      this.settings = next;
      if (!next.enabled) this.reset();
      else this.emit();
      return this.snapshot();
    }
    begin(source, data = {}) {
      if (
        !this.settings.enabled ||
        !["report", "chat", "task", "handoff"].includes(source) ||
        !safeId(data.id)
      )
        return false;
      const previous = this.activities.get(source);
      if (previous?.id === data.id) return true;
      this.activities.set(source, {
        id: data.id,
        source,
        label: {
          report: "正在整理工作简报",
          chat: "正在组织这次回答",
          task: "正在理解并处理任务",
          handoff: "有一份交接请求等你确认",
        }[source],
        form: chooseForm({ ...data, source }, this.settings.mode),
        transition: this.settings.transition,
        waiting: false,
      });
      this.stopDive(source);
      this.startDive(source);
      this.refresh();
      return true;
    }
    startDive(source) {
      const item = this.activities.get(source);
      if (!item || item.form !== "artisan" || this.settings.mode !== "auto")
        return;
      const dive = this.dives.get(source) || { worked: 0 };
      this.cancelTimer(dive.timer);
      dive.since = this.now();
      dive.timer = this.schedule(
        () => this.dive(source, item.id),
        Math.max(0, DEEP_AFTER_MS - dive.worked),
      );
      this.dives.set(source, dive);
    }
    pauseDive(source) {
      const dive = this.dives.get(source);
      if (!dive || dive.since === undefined) return;
      this.cancelTimer(dive.timer);
      dive.worked += this.now() - dive.since;
      dive.since = dive.timer = undefined;
    }
    stopDive(source) {
      const dive = this.dives.get(source);
      if (dive) this.cancelTimer(dive.timer);
      this.dives.delete(source);
    }
    stopDives() {
      for (const source of [...this.dives.keys()]) this.stopDive(source);
    }
    dive(source, id) {
      this.dives.delete(source);
      const item = this.activities.get(source);
      if (
        !item ||
        item.id !== id ||
        item.form !== "artisan" ||
        item.waiting ||
        this.settings.mode !== "auto"
      )
        return;
      item.form = "deep";
      // Live now: switch in place. Otherwise it shows deep when it is live again.
      if (
        this.live.state.task?.id === id &&
        this.live.state.task?.source === source
      )
        this.live.start({
          ...item,
          label: "这件事要久一点，我潜下去专心处理。",
        });
    }
    refresh() {
      if (!this.settings.enabled) return;
      const priority = { handoff: 40, task: 30, report: 20, chat: 10 };
      const next = [...this.activities.values()].sort(
        (a, b) => priority[b.source] - priority[a.source],
      )[0];
      if (!next) return;
      if (
        this.live.state.task?.id !== next.id ||
        this.live.state.task?.source !== next.source
      )
        this.live.start(next);
      if (next.waiting && this.live.state.phase !== "waiting")
        this.live.waiting(next.id);
      else if (!next.waiting && this.live.state.phase === "waiting")
        this.live.resume(next.id);
    }
    wait(source, id) {
      const item = this.activities.get(source);
      if (!item || item.id !== id) return false;
      item.waiting = true;
      this.pauseDive(source);
      this.refresh();
      return true;
    }
    resume(source, id) {
      const item = this.activities.get(source);
      if (!item || item.id !== id) return false;
      item.waiting = false;
      this.startDive(source);
      this.refresh();
      return true;
    }
    finish(source, id, { ok = true, verified = false } = {}) {
      const item = this.activities.get(source);
      if (!item || item.id !== id) return false;
      this.activities.delete(source);
      this.stopDive(source);
      if (ok && verified && ["report", "task"].includes(source))
        this.lastCompleted = {
          id: `${source}:${id}`,
          kind: source,
          title:
            source === "report"
              ? "共同完成一份工作简报"
              : "共同完成一次确认操作",
          createdAt: this.now(),
        };
      if (this.activities.size) this.refresh();
      else
        this.live.finish(
          id,
          ok,
          source === "chat" && ok ? "这次回复已经结束。" : undefined,
        );
      this.emit();
      return true;
    }
    cancel(source, id) {
      const item = this.activities.get(source);
      if (!item || (id && item.id !== id)) return false;
      this.activities.delete(source);
      this.stopDive(source);
      if (this.activities.size) this.refresh();
      else this.live.reset();
      return true;
    }
    observe(event) {
      if (!this.settings.enabled || !event || typeof event.type !== "string")
        return;
      const d = event.data || {};
      if (
        event.type === "connection" &&
        ["offline", "connecting"].includes(d.status)
      ) {
        this.activities.clear();
        this.stopDives();
        this.live.reset();
        return;
      }
      const source =
        event.type === "job.changed"
          ? "report"
          : ["chat.activity", "chat.changed"].includes(event.type)
            ? "chat"
            : null;
      if (source) {
        const id = safeId(d.id)
          ? d.id
          : source === "chat"
            ? "current-chat"
            : "";
        const active =
          source === "chat"
            ? d.status === "streaming"
            : ["queued", "running"].includes(d.status);
        if (active)
          this.begin(source, {
            id,
            effort: d.effort,
            plannedSteps: d.plannedSteps,
          });
        else if (["finished", "complete"].includes(d.status))
          this.finish(source, id, { ok: true, verified: source === "report" });
        else if (["failed", "error"].includes(d.status))
          this.finish(source, id, { ok: false });
        else if (["cancelled", "idle"].includes(d.status))
          this.cancel(source, id);
      }
      if (event.type === "handoff.changed") {
        const pending = Array.isArray(d.pending)
          ? d.pending.find((item) => safeId(item?.id))
          : null;
        if (pending) {
          this.begin("handoff", { id: pending.id });
          this.wait("handoff", pending.id);
        } else this.cancel("handoff"); // disappearing can mean approved, rejected or expired; never infer success
      }
    }
    recordMilestone(id) {
      if (!this.lastCompleted || id !== this.lastCompleted.id)
        throw new Error("请先完成真实任务，再记录里程碑。");
      if (this.milestones.some((item) => item.id === id))
        return this.snapshot();
      const next = [...this.milestones, { ...this.lastCompleted }].slice(-20);
      this.persist(this.persisted(this.settings, next));
      this.milestones = next;
      this.emit();
      return this.snapshot();
    }
    laterDemo(ms, fn) {
      const revision = this.demoRevision;
      const timer = this.schedule(() => {
        this.demoTimers.delete(timer);
        if (revision === this.demoRevision) fn();
      }, ms);
      this.demoTimers.add(timer);
    }
    startDemo(form) {
      if (!["artisan", "deep"].includes(form))
        throw new Error("演示形态无效。");
      this.stopDemo();
      this.demoInfo = {
        stage: "starting",
        id: `demo-${this.demoRevision}`,
        form,
      };
      this.demo.start({
        id: this.demoInfo.id,
        source: "demo",
        label: form === "deep" ? "演示：拆解复杂问题" : "演示：整理一份资料",
        form,
        transition: this.settings.transition,
      });
      return this.snapshot();
    }
    continueDemo() {
      if (!this.demoInfo || this.demoInfo.stage !== "waiting")
        throw new Error("演示还没有进入等待阶段。");
      this.demoInfo.stage = "verifying";
      this.demo.resume(this.demoInfo.id);
      this.laterDemo(1100, () => {
        this.demoInfo.stage = "finished";
        this.demo.finish(
          this.demoInfo.id,
          true,
          "演示验证已结束，没有执行真实任务。",
        );
      });

      return this.snapshot();
    }
    failDemo() {
      if (
        !this.demoInfo ||
        ["finished", "blocked"].includes(this.demoInfo.stage)
      )
        throw new Error("请先开始一段演示。");
      this.demoRevision++;
      for (const timer of this.demoTimers) this.cancelTimer(timer);
      this.demoTimers.clear();
      this.demoInfo.stage = "blocked";
      this.demo.finish(
        this.demoInfo.id,
        false,
        "演示：信息不足，先停下来请求帮助。",
      );

      return this.snapshot();
    }
    skipLive() {
      this.live.skipTransition();
      return this.snapshot();
    }
    skipDemo() {
      this.demo.skipTransition();
      return this.snapshot();
    }
    stopDemo() {
      this.demoRevision++;
      for (const timer of this.demoTimers) this.cancelTimer(timer);
      this.demoTimers.clear();
      this.demoInfo = null;
      this.demo.reset();
      return this.snapshot();
    }
    reset() {
      this.activities.clear();
      this.stopDives();
      this.lastCompleted = null;
      this.live.reset();
      this.stopDemo();
    }
    close() {
      this.stopDives();
      this.demoRevision++;
      for (const timer of this.demoTimers) this.cancelTimer(timer);
      this.demoTimers.clear();
      this.live.close();
      this.demo.close();
    }
  }
  return {
    EvolutionMachine,
    EvolutionController,
    chooseForm,
    FORMS,
    LABELS,
    EVOLVE_MS,
    CINEMATIC_MS,
    DEEP_AFTER_MS,
    TRANSITIONS,
    transitionMs,
    RESULT_MS,
  };
});
