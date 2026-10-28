#pragma once
#include <Arduino.h>

// D pixel otter animations in the ffat data partition, from two banks:
// - the expressions (scripts/build-pixel-skin.py) at the start, up to four frames each;
// - the evolved forms (scripts/build-evolution-pack.py) 3 MiB in: longer clips,
//   transitions that play once, and returns that reuse a transition backwards.
// Both banks share one list of names. If the first bank is missing or damaged,
// available() stays false and the procedural face in face.cpp is used instead; a
// missing second bank only means there are no evolved forms.
namespace skin {
bool begin();
bool available();
size_t count();             // clips in both banks
size_t evolutionCount();    // clips from the second bank
const char *name(int clip);
int find(const char *name);  // -1 if neither bank has it
// Makes `clip` current and decodes its first frame, so a damaged clip fails here.
bool select(int clip);
uint32_t lastDecodeMs();
// Which frame of the current clip shows `elapsedMs` after it started; a play-once
// clip stays on its last frame. -1 if no clip is selected.
int frameAt(uint32_t elapsedMs);
// The pixels of frame `index` of the current clip, decoded on first use into one of
// four PSRAM buffers. nullptr if it cannot be decoded.
const uint16_t *pixels(int index);
}
