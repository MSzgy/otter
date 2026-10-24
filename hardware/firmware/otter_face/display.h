#pragma once
#include <Arduino.h>

namespace screen {
constexpr int width = 240;
constexpr int height = 320;
void begin();
void present(const uint16_t *pixels);

// Pixels are stored in SPI wire order (high byte first).
constexpr uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  const uint16_t color = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
  return (color << 8) | (color >> 8);
}
}
