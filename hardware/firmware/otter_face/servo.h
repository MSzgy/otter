#pragma once
#include <Arduino.h>

namespace servo {
struct Status {
  uint16_t position, speed, load;
  float volts;
  uint8_t temperature;
  bool torque;
};

// Lesson 6's software range, narrower than the servos' own 20..1003. Every servo
// starts with it; the head (lesson 9) swaps in the measured travel.
constexpr uint16_t center = 511, softLow = center - 150, softHigh = center + 150;
constexpr uint16_t defaultSpeed = 40;  // steps per second

enum class MoveResult { Started, UnknownServo, OutOfRange, TooFar, NoReply, Unsafe };

struct MoveOptions {
  uint16_t speed = defaultSpeed;
  uint8_t tolerance = 3;  // arrived when this close to the target
  bool report = true;     // print EVENT ... arrived (faults are always printed)
};

// Starts UART1 to Bus Servo Adapter (A) at 1 Mbps.
void begin();
// Pings IDs 0..253 and stores responders in `ids`. Takes about one second.
size_t scan(uint8_t *ids, size_t capacity);
bool readStatus(uint8_t id, Status &status);

// Motion, for servos 1 and 2 only. move() returns at once; update() drives the
// motion from loop(), checks safety, and prints EVENT lines when a move ends.
MoveResult move(uint8_t id, uint16_t target, const MoveOptions &options = {});
bool release(uint8_t id);
// Targets allowed for a servo, always also within its own limits. maxJump > 0 also
// limits each move to that many steps from where the servo is now.
void setRange(uint8_t id, uint16_t low, uint16_t high, uint16_t maxJump = 0);
bool range(uint8_t id, uint16_t &low, uint16_t &high);
bool settled(uint8_t id);   // torque on and the last move has ended
uint32_t faults(uint8_t id);  // counts fault releases, so a caller can notice one
void stopAll();     // hold every torqued servo where it is now
bool moving();      // any servo still travelling
bool holding();     // any servo with torque on
void update(uint32_t now, Print &out);

// Diagnostic: sends one PING and returns every byte heard for 10 ms, echo included.
size_t rawPing(uint8_t id, uint8_t *received, size_t capacity);
// Diagnostic: idle levels of GPIO43 and GPIO44 with pull-down then pull-up.
void probePins(int levels[4]);
}
