#pragma once
#include <Arduino.h>

// D pixel otter animations, packed by scripts/build-pixel-skin.py into the ffat data
// partition. Each expression has up to four full-screen frames with their own delays.
// If the pack is missing or damaged, available() stays false and the procedural face
// in face.cpp is used instead.
namespace skin {
bool begin();
bool available();
size_t count();
const char *name(int expression);
int find(const char *name);  // -1 if the pack has no such expression
// Decodes the expression's frames into PSRAM; does nothing if it is already loaded.
bool select(int expression);
uint32_t lastDecodeMs();
// Frame for `elapsedMs` since the expression started, or nullptr if none is loaded.
const uint16_t *frame(uint32_t elapsedMs);
}
