import { useEffect, useState } from "react";
import { Otter } from "./Otter";
import type { PetSnapshot, Snapshot } from "./types";
export const initialPet: PetSnapshot = {
  asleep: false,
  interactions: 0,
  lastAction: null,
  lastAt: 0,
  mood: "idle",
  caption: "点头摸摸 · 右键互动",
  effect: null,
};
export const interactions = [
  { id: "pet", label: "摸摸头", hint: "眯眼，收下一点温柔", icon: "♡" },
  { id: "feed", label: "喂小鱼", hint: "抱着小鱼，慢慢吃", icon: "◁" },
  { id: "play", label: "玩小球", hint: "一起接住弹跳的小球", icon: "●" },
  { id: "dance", label: "跳个舞", hint: "晃晃脑袋，松松肩膀", icon: "♪" },
  { id: "wave", label: "打招呼", hint: "挥挥小爪子，回应你", icon: "☀" },
  { id: "tickle", label: "挠痒痒", hint: "肚皮好痒，笑得晃起来", icon: "✧" },
];
export function usePetState() {
  const [pet, setPet] = useState<PetSnapshot>(initialPet);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true,
      revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.otter.subscribe((event) => {
      if (event.type === "pet.changed") {
        revision++;
        setPet(event.data);
        setNotice("");
      }
      if (event.type === "pet.notice") {
        setNotice(event.data.message);
        clearTimeout(timer);
        timer = setTimeout(() => setNotice(""), 3000);
      }
    });
    const v = revision;
    void window.otter
      .action<Snapshot>("snapshot")
      .then((s) => {
        if (alive && v === revision && s.pet) setPet(s.pet);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!pet.effect) return;
    const timer = setTimeout(
      () =>
        setPet((p) => ({
          ...p,
          effect: null,
          mood: p.asleep ? "sleeping" : "idle",
          caption: p.asleep ? "嘘…水獭睡着了" : "点头摸摸 · 右键互动",
        })),
      Math.max(0, pet.effect.expiresAt - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [pet.effect?.id]);
  async function interact(id: string) {
    try {
      const next = await window.otter.action<PetSnapshot>("pet.interact", id);
      setPet(next);
      setNotice("");
    } catch (e) {
      setNotice(
        e instanceof Error
          ? e.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )
          : String(e),
      );
    }
  }
  return { pet, notice, interact };
}
export function PetInteractions() {
  const { pet, notice, interact } = usePetState();
  return (
    <section className="interaction-page" aria-label="陪伴互动">
      <div className="heading">
        <p className="eyebrow">不用说话，也能陪着你</p>
        <h1>和小水獭玩一会儿。</h1>
        <p className="muted">所有互动都在本机完成，断网也能玩。</p>
      </div>
      <div className="interaction-stage">
        <Otter mood={pet.mood} size={210} />
        <div>
          <p className="interaction-speech" role="status">
            {notice || pet.caption}
          </p>
          <p className="interaction-state">
            {pet.asleep ? "正在休息" : "醒着陪你"} · 已互动 {pet.interactions}{" "}
            次
          </p>
          <button onClick={() => interact(pet.asleep ? "wake" : "sleep")}>
            {pet.asleep ? "叫醒水獭" : "睡一会儿"}
          </button>
        </div>
      </div>
      <div className="interaction-grid">
        {interactions.map((a) => (
          <button
            key={a.id}
            aria-label={a.label}
            disabled={pet.asleep}
            onClick={() => interact(a.id)}
          >
            <span aria-hidden="true">{a.icon}</span>
            <div>
              <strong>{a.label}</strong>
              <small>{a.hint}</small>
            </div>
          </button>
        ))}
      </div>
      <div className="interaction-guide">
        <h2>在桌面上也能互动</h2>
        <ul>
          <li>点一下头顶：摸摸头；点身体：打开聊天。</li>
          <li>按住并拖动：把水獭提起来，放到喜欢的位置。</li>
          <li>右键水獭：打开互动菜单；也可以使用顶部菜单栏的“陪伴互动”。</li>
          <li>
            水獭睡觉时，点一下就能叫醒。休息不会关闭聊天，也不会改变通知设置。
          </li>
        </ul>
        <p>
          快速重复喂食或玩耍会提示稍等。动作结束后自动恢复，不会排队一直播放。
        </p>
      </div>
    </section>
  );
}
