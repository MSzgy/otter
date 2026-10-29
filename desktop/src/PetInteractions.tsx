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
  { id: "pet", label: "摸摸头", icon: "🤚" },
  { id: "feed", label: "喂小鱼", icon: "🐟" },
  { id: "play", label: "玩小球", icon: "⚽️" },
  { id: "dance", label: "跳个舞", icon: "💃" },
  { id: "wave", label: "打招呼", icon: "👋" },
  { id: "tickle", label: "挠痒痒", icon: "🤭" },
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
// The top of 我的水獭: the otter itself, what it is saying, and things to do with it.
export function PetInteractions() {
  const { pet, notice, interact } = usePetState();
  return (
    <section className="otter-hero interaction-stage" aria-label="陪伴互动">
      <Otter mood={pet.mood} size={210} />
      <div>
        <h1>我的水獭</h1>
        <div className="otter-tags">
          <span>{pet.asleep ? "正在休息" : "醒着陪你"}</span>
          <span>已互动 {pet.interactions} 次</span>
        </div>
        <p className="interaction-speech" role="status">
          {notice || pet.caption}
        </p>
        <div className="otter-actions">
          {interactions.map((a) => (
            <button
              key={a.id}
              aria-label={a.label}
              disabled={pet.asleep}
              onClick={() => interact(a.id)}
            >
              <i aria-hidden="true">{a.icon}</i>
              {a.label}
            </button>
          ))}
          <button onClick={() => interact(pet.asleep ? "wake" : "sleep")}>
            <i aria-hidden="true">{pet.asleep ? "☀️" : "😴"}</i>
            {pet.asleep ? "叫醒水獭" : "睡一会儿"}
          </button>
        </div>
      </div>
    </section>
  );
}

// One line on the otter page; the desktop pet itself is where these happen.
export function DesktopTips() {
  return (
    <p className="otter-tip">
      在桌面上：点头顶摸摸头，点身体打开聊天，按住拖动换个位置，右键打开互动菜单。
    </p>
  );
}
