import { useState } from "react";
import { Otter } from "./Otter";
import {
  companionState,
  formLabels,
  phaseLabels,
  useEvolution,
  type EvolutionForm,
  type EvolutionSnapshot,
} from "./evolution-runtime";
import "./evolution.css";
const formDescriptions: Record<EvolutionForm, string> = {
  companion: "抱着小石头，陪你过日常",
  artisan: "挺起肩膀，把手边的事做好",
  deep: "带上光石，潜入复杂问题",
};
export function EvolutionWorkshop() {
  const { state, setState } = useEvolution();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function action(name: string, value?: unknown) {
    setError("");
    setPending(true);
    try {
      setState(await window.otter.action<EvolutionSnapshot>(name, value));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )
          : String(e),
      );
    } finally {
      setPending(false);
    }
  }
  if (!state) return null;
  const demo = state.demo;
  const completed = state.lastCompleted;
  const recorded =
    !!completed && state.milestones.some((item) => item.id === completed.id);
  return (
    <section className="evolution-workshop" aria-label="任务进化">
      <div className="evolution-heading">
        <div>
          <p className="eyebrow">一起认真，一起长大</p>
          <h2>遇到难题，换个工作形态。</h2>
        </div>
        <span className="evolution-count">
          已留下 {state.milestones.length} 个里程碑
        </span>
      </div>
      <p className="muted">
        进化表达当前工作强度。任务结束后，它会收好工具，回到你身边。
      </p>
      <div className="evolution-settings">
        <label>
          <input
            type="checkbox"
            checked={state.settings.enabled}
            disabled={pending}
            onChange={(e) =>
              void action("evolution.configure", {
                ...state.settings,
                enabled: e.target.checked,
              })
            }
          />
          启用任务进化
        </label>
        <label>
          下次任务的工作形态
          <select
            aria-label="工作形态偏好"
            value={state.settings.mode}
            disabled={pending}
            onChange={(e) =>
              void action("evolution.configure", {
                ...state.settings,
                mode: e.target.value,
              })
            }
          >
            <option value="auto">自动判断</option>
            <option value="artisan">偏好工匠</option>
            <option value="deep">偏好深潜</option>
          </select>
        </label>
        <label>
          进化演出
          <select
            aria-label="进化演出"
            value={state.settings.transition}
            disabled={pending}
            onChange={(e) =>
              void action("evolution.configure", {
                ...state.settings,
                transition: e.target.value,
              })
            }
          >
            <option value="cinematic">完整演出 · 2.4秒</option>
            <option value="quick">简短过渡 · 0.64秒</option>
            <option value="none">不播放过渡</option>
          </select>
        </label>
      </div>
      <p className="evolution-boundary">
        仅影响外观，不更换模型或计算预算。自动模式下普通聊天保留陪伴，简报和确认任务用工匠；
        工匠工作超过 20 秒会潜入深潜，等你确认的时间不算。
      </p>
      <div className="evolution-forms">
        {(["companion", "artisan", "deep"] as EvolutionForm[]).map((form) => (
          <article
            className={state.live.form === form ? "active" : ""}
            key={form}
          >
            <Otter
              size={145}
              mood="idle"
              evolution={{
                ...companionState,
                form,
                phase: form === "companion" ? "idle" : "working",
              }}
            />
            <strong>{formLabels[form]}</strong>
            <p>{formDescriptions[form]}</p>
          </article>
        ))}
      </div>
      <div className="evolution-live" role="status">
        <span>真实任务</span>
        <strong>
          {formLabels[state.live.form]} · {phaseLabels[state.live.phase]}
        </strong>
        <p>{state.live.caption}</p>
        {["evolving", "returning"].includes(state.live.phase) && (
          <button
            disabled={pending}
            onClick={() => void action("evolution.skip")}
          >
            跳过当前进化演出
          </button>
        )}
        {state.live.phase === "waiting" && (
          <small>
            请在原来的聊天或 AI 交接面板处理请求，这里不会代你批准。
          </small>
        )}
      </div>
      <section className="evolution-demo" aria-label="进化流程演示">
        <div className="evolution-demo-heading">
          <h3>先看它认真工作一次</h3>
          <span>本地演示</span>
        </div>
        <p>演示不会请求模型、执行任务、批准交接或计入成长。</p>
        <div className="button-row">
          <button
            disabled={pending}
            onClick={() =>
              void action("evolution.demo.start", { form: "artisan" })
            }
          >
            演示工匠流程
          </button>
          <button
            disabled={pending}
            onClick={() =>
              void action("evolution.demo.start", { form: "deep" })
            }
          >
            演示深潜流程
          </button>
          {demo && (
            <button
              disabled={pending}
              onClick={() => void action("evolution.demo.stop")}
            >
              结束演示
            </button>
          )}
        </div>
        {demo && ["evolving", "returning"].includes(demo.phase) && (
          <button
            disabled={pending}
            onClick={() => void action("evolution.demo.skip")}
          >
            跳过演示进化
          </button>
        )}
        <div className="evolution-demo-stage">
          <Otter size={230} mood="idle" evolution={demo || companionState} />
          <div>
            <strong>
              {demo
                ? `${formLabels[demo.form]} · ${phaseLabels[demo.phase]}`
                : "准备好，就开始吧。"}
            </strong>
            <p role="status">
              {demo
                ? demo.caption.replace(
                    "等你在原来的面板里决定。",
                    "演示停在这里，等你选择继续。",
                  )
                : "开始 → 进化 → 工作 → 等待确认 → 验证 → 完成 → 回到陪伴"}
            </p>
            {demo?.stage === "waiting" && (
              <button
                className="primary"
                disabled={pending}
                onClick={() => void action("evolution.demo.continue")}
              >
                继续演示验证
              </button>
            )}
            {demo && !["finished", "blocked"].includes(demo.stage) && (
              <button
                disabled={pending}
                onClick={() => void action("evolution.demo.fail")}
              >
                演示遇到问题
              </button>
            )}
          </div>
        </div>
      </section>
      <section className="evolution-growth" aria-label="共同成长">
        <h3>留下完成过的事</h3>
        <p>
          真实简报生成、确认操作完成后，由你决定是否记为里程碑。成长不按 token
          消耗或在线时长累积，也不限制功能。
        </p>
        {completed ? (
          <div className="evolution-milestone-action">
            <span>{completed.title}</span>
            <button
              disabled={pending || recorded || !!demo}
              onClick={() =>
                void action("evolution.milestone", { id: completed.id })
              }
            >
              {recorded ? "已记下" : "记下这次完成"}
            </button>
          </div>
        ) : (
          <p className="muted">
            还没有可记录的真实完成事件；演示不会解锁里程碑。
          </p>
        )}
        {!!state.milestones.length && (
          <ul>
            {state.milestones
              .slice(-5)
              .reverse()
              .map((item) => (
                <li key={item.id}>
                  <span>{item.title}</span>
                  <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                </li>
              ))}
          </ul>
        )}
      </section>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
