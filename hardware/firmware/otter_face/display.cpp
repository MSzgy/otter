#include "display.h"
#include <SPI.h>

// Pin map and panel register values checked against Waveshare's V2 example:
// ESP32-S3-Touch-LCD-2.8 / Arduino/examples/LVGL_Arduino/Display_ST7789.*
// This driver deliberately controls only the onboard screen and backlight.
namespace screen {
constexpr uint8_t pinClock = 40, pinMosi = 45, pinCs = 42;
constexpr uint8_t pinDc = 41, pinReset = 39, pinBacklight = 5;
SPIClass bus(FSPI);

void command(uint8_t value, const uint8_t *data = nullptr, size_t count = 0) {
  bus.beginTransaction(SPISettings(40000000, MSBFIRST, SPI_MODE0));
  digitalWrite(pinCs, LOW);
  digitalWrite(pinDc, LOW);
  bus.transfer(value);
  if (count) {
    digitalWrite(pinDc, HIGH);
    bus.writeBytes(data, count);
  }
  digitalWrite(pinCs, HIGH);
  bus.endTransaction();
}

struct Setting { uint8_t command, length, data[14]; };
const Setting settings[] = {
  {0x36, 1, {0x00}}, {0x3a, 1, {0x05}}, {0xb0, 2, {0x00, 0xe8}},
  {0xb2, 5, {0x0c, 0x0c, 0x00, 0x33, 0x33}}, {0xb7, 1, {0x75}},
  {0xbb, 1, {0x1a}}, {0xc0, 1, {0x2c}}, {0xc2, 2, {0x01, 0xff}},
  {0xc3, 1, {0x13}}, {0xc4, 1, {0x20}}, {0xc6, 1, {0x0f}},
  {0xd0, 2, {0xa4, 0xa1}}, {0xd6, 1, {0xa1}},
  {0xe0, 14, {0xd0, 0x0d, 0x14, 0x0d, 0x0d, 0x09, 0x38, 0x44, 0x4e, 0x3a, 0x17, 0x18, 0x2f, 0x30}},
  {0xe1, 14, {0xd0, 0x09, 0x0f, 0x08, 0x07, 0x14, 0x37, 0x44, 0x4d, 0x38, 0x15, 0x16, 0x2c, 0x2e}}
};

void begin() {
  pinMode(pinCs, OUTPUT);
  pinMode(pinDc, OUTPUT);
  pinMode(pinReset, OUTPUT);
  digitalWrite(pinCs, HIGH);
  digitalWrite(pinDc, HIGH);
  pinMode(pinBacklight, OUTPUT);
  digitalWrite(pinBacklight, LOW);
  bus.begin(pinClock, -1, pinMosi, -1);
  digitalWrite(pinReset, LOW);
  delay(50);
  digitalWrite(pinReset, HIGH);
  delay(120);
  command(0x11);  // Leave sleep mode.
  delay(120);
  for (const Setting &setting : settings) command(setting.command, setting.data, setting.length);
  command(0x21);
  command(0x29);
  delay(20);
  ledcAttach(pinBacklight, 20000, 10);
  ledcWrite(pinBacklight, 500);  // Start at approximately 50% brightness.
}

void present(uint16_t *pixels) {
  const uint8_t columns[] = {0, 0, 0, width - 1};
  const uint8_t rows[] = {0, 0, (height - 1) >> 8, (height - 1) & 0xff};
  command(0x2a, columns, sizeof(columns));
  command(0x2b, rows, sizeof(rows));
  command(0x2c);
  bus.beginTransaction(SPISettings(40000000, MSBFIRST, SPI_MODE0));
  digitalWrite(pinCs, LOW);
  digitalWrite(pinDc, HIGH);
  bus.writeBytes(reinterpret_cast<uint8_t *>(pixels), width * height * sizeof(uint16_t));
  digitalWrite(pinCs, HIGH);
  bus.endTransaction();
}
}
