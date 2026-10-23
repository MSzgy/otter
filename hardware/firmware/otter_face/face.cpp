#include "face.h"
#include "display.h"
#include <cmath>
#include <algorithm>

namespace {
uint16_t *canvas;
constexpr uint16_t background = screen::rgb(24, 46, 38);
constexpr uint16_t eyes = screen::rgb(226, 235, 204);
constexpr uint16_t whiskers = screen::rgb(103, 130, 95);
constexpr uint16_t cheeks = screen::rgb(173, 151, 112);

void pixel(int x, int y, uint16_t color) {
  if (x >= 0 && x < screen::width && y >= 0 && y < screen::height)
    canvas[y * screen::width + x] = color;
}
void ellipse(int cx, int cy, int rx, int ry, uint16_t color) {
  if (rx < 1 || ry < 1) return;
  for (int y = -ry; y <= ry; y++) {
    const float inside = 1.0f - float(y * y) / float(ry * ry);
    const int half = int(rx * sqrtf(std::max(0.0f, inside)));
    for (int x = -half; x <= half; x++) pixel(cx + x, cy + y, color);
  }
}
void line(int x0, int y0, int x1, int y1, uint16_t color, int radius = 1) {
  const int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  int error = dx + dy;
  for (;;) {
    ellipse(x0, y0, radius, radius, color);
    if (x0 == x1 && y0 == y1) break;
    const int twice = 2 * error;
    if (twice >= dy) { error += dy; x0 += sx; }
    if (twice <= dx) { error += dx; y0 += sy; }
  }
}
void eyelid(int cx, int cy, bool happy) {
  for (int x = -19; x <= 19; x++) {
    const float curve = 1.0f - float(x * x) / (19.0f * 19.0f);
    const int y = cy + int((happy ? -11.0f : 5.0f) * curve);
    ellipse(cx + x, y, 3, 3, eyes);
  }
}
}

const char *moodName(Mood mood) {
  switch (mood) {
    case Mood::Happy: return "happy";
    case Mood::Sleeping: return "sleeping";
    case Mood::Thinking: return "thinking";
    case Mood::Speaking: return "speaking";
    default: return "idle";
  }
}

void drawFace(uint16_t *pixels, Mood mood, uint32_t now, bool forcedBlink) {
  canvas = pixels;
  std::fill(pixels, pixels + screen::width * screen::height, background);
  const float t = now / 1000.0f;
  const bool happy = mood == Mood::Happy;
  const bool sleepy = mood == Mood::Sleeping;
  const bool blink = forcedBlink || now % 4200 < 150;
  const int gaze = mood == Mood::Thinking ? int(sinf(t * 1.5f) * 5) : int(sinf(t * 0.4f) * 2);
  for (int cx : {67, 173}) {
    if (happy || sleepy || blink) eyelid(cx, 136, happy);
    else {
      ellipse(cx + gaze, 132, 18, 26, eyes);
      ellipse(cx + gaze + 5, 123, 4, 5, screen::rgb(247, 250, 231));
    }
    if (happy) ellipse(cx, 164, 17, 5, cheeks);
  }
  ellipse(120, 159, 6, 4, whiskers);
  if (mood == Mood::Speaking) {
    ellipse(120, 180, 9, 5 + int(fabsf(sinf(t * 8)) * 10), eyes);
  } else {
    line(106, 175, 113, 180, eyes);
    line(113, 180, 120, 175, eyes);
    line(120, 175, 127, 180, eyes);
    line(127, 180, 134, 175, eyes);
  }
  line(29, 162, 46, 165, whiskers);
  line(28, 173, 46, 173, whiskers);
  line(194, 165, 211, 162, whiskers);
  line(194, 173, 212, 173, whiskers);
  if (mood == Mood::Thinking) {
    for (int i = 0; i < 3; i++)
      ellipse(108 + i * 12, 218, 2 + (int(t * 3) % 3 == i), 2 + (int(t * 3) % 3 == i), whiskers);
  }
  if (sleepy) {
    const int rise = int(sinf(t) * 2);
    line(193, 88 + rise, 205, 88 + rise, whiskers);
    line(205, 88 + rise, 193, 101 + rise, whiskers);
    line(193, 101 + rise, 205, 101 + rise, whiskers);
  }
}
