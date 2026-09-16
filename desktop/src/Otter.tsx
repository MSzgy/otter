import { useEffect, useRef, type RefObject } from "react";
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
  | "held";

// A replaceable 2D desktop body. Business code sends moods, never drawing coordinates.
export function Otter({
  mood = "idle",
  size = 220,
  gaze,
}: {
  mood?: Mood;
  size?: number;
  gaze?: RefObject<{ x: number; y: number }>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = size * dpr;
    el.height = size * dpr;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const start = performance.now();
    function ellipse(
      x: number,
      y: number,
      rx: number,
      ry: number,
      color: string,
      rotation = 0,
    ) {
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    function stroke(points: number[], color: string, width = 2) {
      ctx.beginPath();
      ctx.moveTo(points[0], points[1]);
      ctx.quadraticCurveTo(points[2], points[3], points[4], points[5]);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    function paint() {
      if (stopped) return;
      ctx.setTransform((dpr * size) / 240, 0, 0, (dpr * size) / 240, 0, 0);
      ctx.clearRect(0, 0, 240, 240);
      const t = (performance.now() - start) / 1000;
      const animate = !reduced.matches;
      const sway = animate ? Math.sin(t * 1.6) * 1.8 : 0;
      ellipse(120, 216, 64, 9, "rgba(31,64,54,.10)");
      ctx.save();
      const hop =
        animate && ["dancing", "playing"].includes(mood)
          ? -Math.abs(Math.sin(t * 5)) * 7
          : 0;
      ctx.translate(120, 160 + sway + hop);
      const tilt =
        mood === "held"
          ? 0.12
          : animate && mood === "dancing"
            ? Math.sin(t * 6) * 0.08
            : animate && mood === "tickled"
              ? Math.sin(t * 22) * 0.035
              : 0;
      ctx.rotate(tilt);
      if (mood === "waking")
        ctx.scale(1, animate ? 1 + Math.max(0, Math.sin(t * 2)) * 0.05 : 1.04);
      ctx.translate(-120, -160);
      ellipse(158, 182, 19, 40, "#625147", -0.75);
      ellipse(120, 163, 54, 59, "#806c5c");
      ellipse(120, 170, 37, 43, "#c8b49a");
      ellipse(83, 205, 22, 12, "#625147", -0.18);
      ellipse(155, 205, 22, 12, "#625147", 0.18);
      ellipse(78, 77, 18, 19, "#806c5c");
      ellipse(162, 77, 18, 19, "#806c5c");
      ellipse(78, 77, 10, 11, "#c8a692");
      ellipse(162, 77, 10, 11, "#c8a692");
      ellipse(120, 105, 61, 53, "#8f7965");
      ellipse(120, 119, 48, 35, "#e1d1b8");
      const blink = mood === "sleeping" || (animate && t % 4.8 > 4.6);
      if (blink || ["happy", "tickled", "eating"].includes(mood)) {
        stroke([87, 101, 94, 107, 101, 101], "#302e2a", 3.5);
        stroke([139, 101, 146, 107, 153, 101], "#302e2a", 3.5);
      } else {
        const gx = (gaze?.current.x || 0) * 3,
          gy = (gaze?.current.y || 0) * 2;
        ellipse(95 + gx, 102 + gy, 4.5, 6, "#302e2a");
        ellipse(145 + gx, 102 + gy, 4.5, 6, "#302e2a");
        ellipse(96 + gx, 100 + gy, 1.4, 1.5, "#fff");
        ellipse(146 + gx, 100 + gy, 1.4, 1.5, "#fff");
      }
      ellipse(106, 122, 17, 13, "#efe4d0");
      ellipse(134, 122, 17, 13, "#efe4d0");
      ellipse(120, 114, 8, 5.5, "#39332e");
      stroke([120, 119, 120, 132, 111, 129], "#51483d", 2);
      stroke([120, 119, 120, 132, 129, 129], "#51483d", 2);
      for (const y of [118, 125]) {
        stroke([87, y, 75, y - 3, 65, y - 2], "#ae987f", 1.4);
        stroke([153, y, 165, y - 3, 175, y - 2], "#ae987f", 1.4);
      }
      ellipse(80, 123, 9, 4, "rgba(202,133,110,.36)");
      ellipse(160, 123, 9, 4, "rgba(202,133,110,.36)");
      // A small river stone gives the otter a resting pose.
      ellipse(
        122,
        175,
        25,
        19,
        mood === "offline" ? "#adb8b1" : "#6e9b86",
        -0.1,
      );
      stroke([106, 175, 119, 165, 136, 173], "#a5c4b2", 2);
      ellipse(84, 164, 14, 28, "#806c5c", -0.75);
      if (mood === "waving") {
        ellipse(
          166,
          137,
          14,
          29,
          "#806c5c",
          animate ? 0.35 + Math.sin(t * 9) * 0.35 : 0.6,
        );
        ellipse(176, 113, 10, 13, "#c8b49a", 0.3);
      } else ellipse(157, 164, 14, 28, "#806c5c", 0.75);
      if (mood === "eating") {
        const chew = animate ? Math.sin(t * 10) * 2 : 0;
        ellipse(120, 157 + chew, 25, 12, "#739daf", -0.12);
        ctx.fillStyle = "#739daf";
        ctx.beginPath();
        ctx.moveTo(101, 157 + chew);
        ctx.lineTo(87, 146 + chew);
        ctx.lineTo(89, 170 + chew);
        ctx.closePath();
        ctx.fill();
        ellipse(135, 154 + chew, 2, 2, "#273d3c");
        stroke([116, 149, 121, 155, 114, 164], "#b2cdd0", 2);
      }
      if (mood === "playing") {
        const ballY = animate ? 174 - Math.abs(Math.sin(t * 4)) * 45 : 148;
        ellipse(125, ballY, 15, 15, "#dcaa65");
        stroke([113, ballY - 8, 125, ballY + 5, 137, ballY + 7], "#f4d5a7", 2);
      }
      if (["happy", "tickled"].includes(mood)) {
        const rise = animate ? (t % 1.5) * 9 : 4;
        ctx.fillStyle = "#bd8875";
        ctx.font = "18px system-ui";
        ctx.fillText("♥", 173, 67 - rise);
      }
      if (mood === "dancing") {
        ctx.fillStyle = "#6b9277";
        ctx.font = "23px system-ui";
        ctx.fillText("♪", 48, 65);
        ctx.fillText("♫", 175, 63);
      }
      if (mood === "held") {
        ctx.fillStyle = "#7a907c";
        ctx.font = "17px system-ui";
        ctx.fillText("!", 181, 77);
      }
      if (mood === "working") {
        const angle = animate ? t * 2 : 0;
        for (let i = 0; i < 3; i++)
          ellipse(104 + i * 16, 43 + Math.sin(angle + i) * 3, 3, 3, "#438069");
      }
      if (mood === "sleeping") {
        ctx.font = "16px system-ui";
        ctx.fillStyle = "#6b8076";
        ctx.fillText("z", 177, 68);
        ctx.font = "12px system-ui";
        ctx.fillText("z", 191, 51);
      }
      ctx.restore();
      if (!document.hidden && animate) timer = setTimeout(paint, 50);
    }
    const resume = () => {
      if (timer) clearTimeout(timer);
      paint();
    };
    document.addEventListener("visibilitychange", resume);
    reduced.addEventListener("change", resume);
    paint();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      reduced.removeEventListener("change", resume);
    };
  }, [mood, size, gaze]);
  return (
    <canvas
      ref={canvas}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`水獭：${{ idle: "陪伴中", working: "正在工作", happy: "开心", offline: "离线", sleeping: "休息中", eating: "吃小鱼", playing: "玩小球", dancing: "跳舞", waving: "打招呼", tickled: "被挠痒痒", waking: "伸懒腰", held: "被提起来" }[mood]}`}
    />
  );
}
