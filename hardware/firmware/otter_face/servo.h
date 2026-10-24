#pragma once
#include <Arduino.h>

namespace servo {
struct Status {
  uint16_t position, load;
  float volts;
  uint8_t temperature;
  bool torque;
};

// Starts UART1 to Bus Servo Adapter (A) at 1 Mbps. Read-only in this version:
// only PING and READ are ever sent, so no servo can move.
void begin();
// Pings IDs 0..253 and stores responders in `ids`. Takes about one second.
size_t scan(uint8_t *ids, size_t capacity);
bool readStatus(uint8_t id, Status &status);
// Diagnostic: sends one PING and returns every byte heard for 10 ms, echo included.
size_t rawPing(uint8_t id, uint8_t *received, size_t capacity);
// Diagnostic: idle levels of GPIO43 and GPIO44 with pull-down then pull-up.
void probePins(int levels[4]);
}
