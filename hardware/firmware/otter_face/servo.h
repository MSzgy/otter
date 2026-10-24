#pragma once
#include <Arduino.h>

namespace servo {
struct Status {
  uint16_t position, speed, load;
  float volts;
  uint8_t temperature;
  bool torque;
};

enum class MoveResult { Started, UnknownServo, OutOfRange, NoReply, Unsafe };

// Software range for lesson 6, narrower than the servos' own 20..1003 until the
// head mechanism is built and its real travel is measured.
constexpr uint16_t center = 511, softLow = center - 150, softHigh = center + 150;

// Starts UART1 to Bus Servo Adapter (A) at 1 Mbps.
void begin();
// Pings IDs 0..253 and stores responders in `ids`. Takes about one second.
size_t scan(uint8_t *ids, size_t capacity);
bool readStatus(uint8_t id, Status &status);

// Motion, for servos 1 and 2 only. move() returns at once; update() drives the
// motion from loop(), checks safety, and prints EVENT lines when a move ends.
MoveResult move(uint8_t id, uint16_t target);
bool release(uint8_t id);
void stopAll();     // hold every torqued servo where it is now
bool moving();      // any servo still travelling
bool holding();     // any servo with torque on
void update(uint32_t now, Print &out);

// Diagnostic: sends one PING and returns every byte heard for 10 ms, echo included.
size_t rawPing(uint8_t id, uint8_t *received, size_t capacity);
// Diagnostic: idle levels of GPIO43 and GPIO44 with pull-down then pull-up.
void probePins(int levels[4]);
}
