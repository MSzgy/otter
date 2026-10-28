import { useEffect, useState } from "react";
export type EvolutionForm = "companion" | "artisan" | "deep";
export type EvolutionPhase =
  | "idle"
  | "evolving"
  | "working"
  | "waiting"
  | "success"
  | "error"
  | "returning";
export type TransitionStyle = "cinematic" | "quick" | "none";
export type EvolutionState = {
  form: EvolutionForm;
  phase: EvolutionPhase;
  from: EvolutionForm;
  task: { id: string; source: string; label: string } | null;
  caption: string;
  changedAt: number;
  transitionStyle?: TransitionStyle;
  transitionDurationMs?: number;
};
export type EvolutionMilestone = {
  id: string;
  kind: "report" | "task";
  title: string;
  createdAt: number;
};
export type EvolutionSnapshot = {
  settings: {
    enabled: boolean;
    mode: "auto" | "artisan" | "deep";
    transition: TransitionStyle;
  };
  live: EvolutionState;
  demo: (EvolutionState & { stage: string; running: true }) | null;
  lastCompleted: EvolutionMilestone | null;
  milestones: EvolutionMilestone[];
};
export const companionState: EvolutionState = {
  form: "companion",
  phase: "idle",
  from: "companion",
  task: null,
  caption: "我在这里，陪你慢慢来。",
  changedAt: 0,
};
export const formLabels: Record<EvolutionForm, string> = {
  companion: "陪伴形态",
  artisan: "工匠形态",
  deep: "深潜形态",
};
export const phaseLabels: Record<EvolutionPhase, string> = {
  idle: "陪伴",
  evolving: "正在进化",
  working: "认真处理",
  waiting: "等你决定",
  success: "这一步已完成",
  error: "需要帮助",
  returning: "回到陪伴",
};
export function useEvolution() {
  const [state, setState] = useState<EvolutionSnapshot | null>(null);
  useEffect(() => {
    let alive = true,
      revision = 0;
    const off = window.otter.subscribe((event) => {
      if (event.type === "evolution.changed") {
        revision++;
        setState(event.data);
      }
    });
    const version = revision;
    void window.otter
      .action<EvolutionSnapshot>("evolution.get")
      .then((next) => {
        if (alive && version === revision) setState(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, []);
  return { state, setState };
}
