import { useEffect, useRef } from "react";
import {
  useEvolution,
  formLabels,
  phaseLabels,
  type EvolutionState,
  type EvolutionForm,
  type EvolutionPhase,
} from "./evolution-runtime";
// One transparent GIF per mood, made from the ESP32 otter's pixel frames by
// scripts/build_pet_gifs.py, so the desktop and physical otters look the same.
// Inlined because the page runs from file:// under connect-src 'none', where
// fetch cannot load assets. The evolved forms' GIFs are in evolution-assets.ts.
import dancing from "./assets/otter/dancing.gif?inline";
import eating from "./assets/otter/eating.gif?inline";
import happy from "./assets/otter/happy.gif?inline";
import held from "./assets/otter/held.gif?inline";
import idle from "./assets/otter/idle.gif?inline";
import offline from "./assets/otter/offline.gif?inline";
import playing from "./assets/otter/playing.gif?inline";
import sleeping from "./assets/otter/sleeping.gif?inline";
import speaking from "./assets/otter/speaking.gif?inline";
import tickled from "./assets/otter/tickled.gif?inline";
import waking from "./assets/otter/waking.gif?inline";
import waving from "./assets/otter/waving.gif?inline";
import working from "./assets/otter/working.gif?inline";
import type { EvolutionGifs } from "./evolution-assets";

export type Mood =
  | "idle"
  | "working"
  | "happy"
  | "offline"
  | "sleeping"
  | "eating"
  | "playing"
  | "dancing"
  | "waving"
  | "tickled"
  | "waking"
  | "held"
  | "speaking";
const GIFS: Record<Mood, string> = {
  idle,
  working,
  happy,
  offline,
  sleeping,
  eating,
  playing,
  dancing,
  waving,
  tickled,
  waking,
  held,
  speaking,
};
const LABELS: Record<Mood, string> = {
  idle: "陪伴中",
  working: "正在工作",
  happy: "开心",
  offline: "离线",
  sleeping: "休息中",
  eating: "吃小鱼",
  playing: "玩小球",
  dancing: "跳舞",
  waving: "打招呼",
  tickled: "被挠痒痒",
  waking: "伸懒腰",
  held: "被提起来",
  speaking: "正在说话",
};

// About 2 MB, loaded the first time an evolved form is shown; see evolution-assets.ts.
let evolutionGifs:
  Promise<Record<"artisan" | "deep", EvolutionGifs>> | undefined;
function loadEvolutionGifs() {
  if (!evolutionGifs) {
    evolutionGifs = import("./evolution-assets").then((m) => m.EVOLUTION);
    evolutionGifs.catch(() => (evolutionGifs = undefined));
  }
  return evolutionGifs;
}
// Which of a form's GIFs shows a phase.
function evolutionGif(
  gifs: EvolutionGifs,
  phase: EvolutionPhase,
  style: EvolutionState["transitionStyle"],
) {
  if (phase === "evolving")
    return style === "cinematic" ? gifs.cinematic : gifs.to;
  if (phase === "returning") return gifs.from;
  if (phase === "success") return gifs.success;
  if (phase === "waiting" || phase === "error") return gifs.waiting;
  return gifs.work;
}

type Frame = { image: ImageBitmap; ms: number };
const decoded = new Map<string, Promise<Frame[]>>();

// Decodes every frame once per GIF; all Otter instances share the bitmaps.
async function decode(url: string): Promise<Frame[]> {
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) =>
    c.charCodeAt(0),
  );
  if (typeof ImageDecoder === "undefined")
    // Without WebCodecs the first frame still shows the right otter, just still.
    return [
      {
        image: await createImageBitmap(
          new Blob([bytes], { type: "image/gif" }),
        ),
        ms: Infinity,
      },
    ];
  const decoder = new ImageDecoder({ data: bytes, type: "image/gif" });
  try {
    await decoder.tracks.ready;
    const frames: Frame[] = [];
    for (let i = 0; i < decoder.tracks.selectedTrack!.frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      frames.push({
        image: await createImageBitmap(image),
        ms: (image.duration ?? 1e6) / 1000, // microseconds in WebCodecs
      });
      image.close();
    }
    return frames;
  } finally {
    decoder.close();
  }
}
function framesFor(key: string, url: string) {
  let pending = decoded.get(key);
  if (!pending) {
    pending = decode(url);
    decoded.set(key, pending);
    pending.catch(() => decoded.delete(key));
  }
  return pending;
}

// The pixel art fills its GIF edge to edge. Drawn at this share of the canvas and
// sitting low, the companion is about the size the earlier drawn otter was; the
// evolved forms carry more gear and are drawn larger.
const ART = {
  companion: { scale: 0.68, bottom: 0.92 },
  artisan: { scale: 0.82, bottom: 0.94 },
  deep: { scale: 0.92, bottom: 0.94 },
};
// For hit areas: is a canvas-relative y (0 top, 1 bottom) on the otter's head?
// The top 35% of the otter (ears, forehead, eyes) is for head pats, as with the
// earlier drawn otter; below it a click opens chat, including at the centre.
export function onHead(y: number, form: EvolutionForm = "companion") {
  const art = ART[form];
  return (y - (art.bottom - art.scale)) / art.scale < 0.35;
}

// A replaceable 2D desktop body. Business code sends moods, never drawing
// coordinates. Each mood loops its own frames at the GIF's own timing; the canvas
// keeps transparent pixels, which the pet window uses to let clicks pass through.
// While evolution is on and the otter is idle or working, the evolved form's GIF
// for the current phase replaces the mood's.
export function Otter({
  mood = "idle",
  size = 220,
  evolution,
}: {
  mood?: Mood;
  size?: number;
  evolution?: EvolutionState | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { state } = useEvolution();
  const candidate =
    evolution === undefined
      ? state?.settings.enabled
        ? state.live
        : null
      : evolution;
  const evolved =
    candidate &&
    candidate.form !== "companion" &&
    ["idle", "working"].includes(mood)
      ? candidate
      : null;
  const form: EvolutionForm = evolved?.form || "companion";
  const phase = evolved?.phase || "idle";
  const style = evolved?.transitionStyle;
  const key =
    form !== "companion"
      ? form +
        ":" +
        phase +
        (phase === "evolving" ? ":" + (style || "quick") : "")
      : "companion:" + mood;
  // Transitions play once and stop on their last frame.
  const loop =
    form === "companion" || !["evolving", "returning"].includes(phase);
  const transitionInstance = loop
    ? ""
    : `${evolved?.task?.id || ""}:${evolved?.changedAt || 0}`;
  useEffect(() => {
    const el = canvas.current!,
      ctx = el.getContext("2d")!,
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = size * dpr;
    el.height = size * dpr;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frames: Frame[] = [],
      index = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    function draw() {
      if (stopped || !frames.length) return;
      ctx.clearRect(0, 0, el.width, el.height);
      const art = ART[form],
        image = frames[index].image;
      // Pixel art stays crisp only when every source pixel covers the same whole
      // number of canvas pixels. Near such a size, snap to it and draw unsmoothed;
      // otherwise smooth, which is softer but keeps every pixel the same width.
      let side = el.width * art.scale;
      const whole = Math.round(side / image.width);
      const crisp = whole >= 1 && Math.abs(side / image.width - whole) <= 0.05;
      if (crisp) side = whole * image.width;
      ctx.imageSmoothingEnabled = !crisp;
      ctx.imageSmoothingQuality = "high";
      const top = el.height * art.bottom - side;
      ctx.drawImage(image, (el.width - side) / 2, top, side, side);
    }
    function schedule() {
      clearTimeout(timer);
      if (
        stopped ||
        reduced.matches ||
        document.hidden ||
        frames.length < 2 ||
        (!loop && index === frames.length - 1)
      )
        return;
      timer = setTimeout(() => {
        index = loop
          ? (index + 1) % frames.length
          : Math.min(index + 1, frames.length - 1);
        draw();
        schedule();
      }, frames[index].ms);
    }
    const resume = () => {
      if (reduced.matches) index = loop ? 0 : Math.max(0, frames.length - 1);
      draw();
      schedule();
    };
    const gif =
      form === "companion"
        ? Promise.resolve(GIFS[mood])
        : loadEvolutionGifs().then((gifs) =>
            evolutionGif(gifs[form], phase, style),
          );
    gif
      .then((url) => framesFor(key, url))
      .then((result) => {
        if (stopped) return;
        frames = result;
        index = 0;
        resume();
      })
      .catch(() => {
        if (!stopped)
          framesFor("companion:idle", idle)
            .then((result) => {
              if (!stopped) {
                frames = result;
                index = 0;
                draw();
              }
            })
            .catch(() => {});
      });
    document.addEventListener("visibilitychange", resume);
    reduced.addEventListener("change", resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      reduced.removeEventListener("change", resume);
    };
  }, [key, size, form, loop, transitionInstance]);
  return (
    <canvas
      ref={canvas}
      style={{ width: size, height: size }}
      role="img"
      data-evolution-form={form}
      data-evolution-phase={phase}
      aria-label={
        evolved
          ? `水獭：${formLabels[form]}，${phaseLabels[phase]}`
          : `水獭：${LABELS[mood]}`
      }
    />
  );
}
