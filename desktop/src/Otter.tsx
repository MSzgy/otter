import { useEffect, useRef } from "react";
// One transparent GIF per mood, made from the ESP32 otter's pixel frames by
// scripts/build_pet_gifs.py, so the desktop and physical otters look the same.
// Inlined because the page runs from file:// under connect-src 'none', where
// fetch cannot load assets.
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

type Frame = { image: ImageBitmap; ms: number };
const decoded = new Map<Mood, Promise<Frame[]>>();

// Decodes every frame once per mood; all Otter instances share the bitmaps.
async function decode(mood: Mood): Promise<Frame[]> {
  const base64 = GIFS[mood].slice(GIFS[mood].indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
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
function framesFor(mood: Mood) {
  let pending = decoded.get(mood);
  if (!pending) {
    pending = decode(mood);
    decoded.set(mood, pending);
    pending.catch(() => decoded.delete(mood));
  }
  return pending;
}

// The pixel art fills its GIF edge to edge. Drawn at this share of the canvas and
// sitting low, it is about the size the earlier drawn otter was.
const ART = { scale: 0.68, bottom: 0.92 };
// For hit areas: is a canvas-relative y (0 top, 1 bottom) on the otter's head?
// The top 35% of the otter (ears, forehead, eyes) is for head pats, as with the
// earlier drawn otter; below it a click opens chat, including at the centre.
export function onHead(y: number) {
  return (y - (ART.bottom - ART.scale)) / ART.scale < 0.35;
}

// A replaceable 2D desktop body. Business code sends moods, never drawing
// coordinates. Each mood loops its own frames at the GIF's own timing; the canvas
// keeps transparent pixels, which the pet window uses to let clicks pass through.
export function Otter({
  mood = "idle",
  size = 220,
}: {
  mood?: Mood;
  size?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = size * dpr;
    el.height = size * dpr;
    ctx.imageSmoothingQuality = "high";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frames: Frame[] = [];
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    function draw() {
      if (stopped || !frames.length) return;
      ctx.clearRect(0, 0, el.width, el.height);
      const side = el.width * ART.scale;
      const top = el.height * ART.bottom - side;
      ctx.drawImage(
        frames[index].image,
        (el.width - side) / 2,
        top,
        side,
        side,
      );
    }
    function schedule() {
      clearTimeout(timer);
      if (stopped || reduced.matches || document.hidden || frames.length < 2)
        return;
      timer = setTimeout(() => {
        index = (index + 1) % frames.length;
        draw();
        schedule();
      }, frames[index].ms);
    }
    const resume = () => {
      if (reduced.matches) index = 0;
      draw();
      schedule();
    };
    framesFor(mood)
      .then((result) => {
        if (stopped) return;
        frames = result;
        index = 0;
        resume();
      })
      .catch(() => {});
    document.addEventListener("visibilitychange", resume);
    reduced.addEventListener("change", resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      reduced.removeEventListener("change", resume);
    };
  }, [mood, size]);
  return (
    <canvas
      ref={canvas}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`水獭：${LABELS[mood]}`}
    />
  );
}
