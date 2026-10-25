#pragma once
#include <Arduino.h>

// Lesson 9: the two-axis head. Servo 1 turns it left and right (pan), servo 2 tilts
// it up and down. Calibration records where "forward" and each end of travel are;
// presets are shares of that travel, so they suit any build and either mounting
// direction. Until calibrated, presets are refused and the servos keep lesson 6's
// software range.
namespace head {
constexpr uint8_t panServo = 1, tiltServo = 2;
constexpr uint16_t calibrationJump = 30;  // steps per move while calibrating

enum class Result { Started, Unknown, NotCalibrated, Calibrating, ServoError };

void begin();  // loads the saved calibration; call after servo::begin()
const char *state();  // "uncalibrated", "calibrating" or "calibrated"
void report(Print &out);  // one JSON line
void listMotions(Print &out);

// While calibrating, servos 1 and 2 may go anywhere within their own limits,
// calibrationJump steps per move, and presets are refused.
void startCalibration(Print &out);
// left, pan centre, right, up, tilt centre, down. Returns nullptr once stored, else why not.
const char *save(const long values[6]);
void cancelCalibration();
void forget();

// Starts a preset, replacing one in progress. Every started preset ends with one
// line: EVENT motion <name> done | failed | stopped.
Result motion(const char *name, Print &out);
void cancel(Print &out);  // drop a running preset; servos hold where they are
void update(uint32_t now, Print &out);  // call after servo::update()
}
