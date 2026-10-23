// 浏览器 Canvas 原型：表达设计可复用，Canvas API 不能直接烧录到 ESP32。
export function drawFace(canvas, mood, now, { reducedMotion = false } = {}) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const t = reducedMotion ? 0 : now / 1000;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = mood === "offline" ? "#25302c" : "#192e26";
  ctx.fillRect(0, 0, w, h);
  const scale = Math.min(w / 320, h / 240);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(scale, scale);
  const ink = mood === "offline" ? "#8f9f91" : "#e3ebce";
  const blink = !reducedMotion && Math.sin(t * .62) > .993;
  const happy = mood === "happy";
  const asleep = mood === "sleeping";
  const shift = mood === "thinking" ? 6 * Math.sin(t * 1.5) : mood === "listening" ? 2 : 0;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const x of [-60, 60]) {
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 8;
    if (happy || asleep || blink) {
      ctx.beginPath();
      ctx.moveTo(x - 22, -17);
      ctx.quadraticCurveTo(x, happy ? -40 : -3, x + 22, -17);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(x + shift, -22, mood === "listening" ? 22 : 19, mood === "thinking" ? 24 : 29, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f6fae8";
      ctx.beginPath();
      ctx.ellipse(x + shift + 5, -32, 5, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (happy) {
      ctx.fillStyle = "#ad9770";
      ctx.globalAlpha = .8;
      ctx.beginPath();
      ctx.ellipse(x, 17, 21, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.fillStyle = "#a8baa0";
  ctx.beginPath();
  ctx.moveTo(-7, 8); ctx.quadraticCurveTo(0, 3, 7, 8); ctx.quadraticCurveTo(0, 18, -7, 8); ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 3;
  if (mood === "speaking") {
    ctx.fillStyle = "#c5d7b5";
    ctx.beginPath();
    ctx.ellipse(0, 31, 11, reducedMotion ? 8 : 5 + Math.abs(Math.sin(t * 8)) * 11, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(-18, 25);
    ctx.quadraticCurveTo(-7, 35, 0, 25);
    ctx.quadraticCurveTo(7, 35, 18, 25);
    ctx.stroke();
  }
  // 两侧短须让屏幕上的脸仍保留水獭的辨识度。
  ctx.strokeStyle = mood === "offline" ? "#67766c" : "#647d63";
  ctx.lineWidth = 2;
  for (const sign of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      ctx.beginPath(); ctx.moveTo(sign * 88, 18 + i * 9); ctx.lineTo(sign * 110, 14 + i * 12); ctx.stroke();
    }
  }
  if (asleep) {
    ctx.fillStyle = "#9caf93";
    ctx.font = "15px ui-rounded, sans-serif";
    ctx.fillText("z", 89, -65 + Math.sin(t) * 3);
    ctx.font = "11px ui-rounded, sans-serif";
    ctx.fillText("z", 109, -79 + Math.sin(t + .5) * 3);
  }
  if (mood === "thinking") {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = reducedMotion ? .6 : .35 + .5 * Math.max(0, Math.sin(t * 3 - i));
      ctx.fillStyle = "#a5ba91";
      ctx.beginPath(); ctx.arc(-12 + i * 12, 71, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (mood === "listening") {
    ctx.strokeStyle = "#7b9b70"; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const height = reducedMotion ? 5 : 3 + Math.abs(Math.sin(t * 4 + i)) * 5;
      ctx.beginPath(); ctx.moveTo(-16 + i * 8, 65 - height); ctx.lineTo(-16 + i * 8, 65 + height); ctx.stroke();
    }
  }
  ctx.restore();
}
