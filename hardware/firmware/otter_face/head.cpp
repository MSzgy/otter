#include "head.h"
#include <Preferences.h>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include "servo.h"

namespace head {
namespace {
constexpr uint16_t lowest = 20, highest = 1003;  // the servos' factory limits
constexpr int minSide = 20;                      // steps, about 6 degrees
constexpr uint8_t calibrationVersion = 1;
constexpr uint8_t passTolerance = 6;  // poses on the way may end this close; the last one 3

struct Calibration {
  uint16_t left, panCenter, right, up, tiltCenter, down;
};
struct Stored {
  uint8_t version;
  Calibration cal;
};

// One pose: pan and tilt as shares of the calibrated travel (+1 = all the way left
// or up, -1 = all the way right or down, 0 = forward), then a pause.
struct Pose {
  float pan, tilt;
  uint16_t holdMs;
};
struct Preset {
  const char *name;
  uint16_t speed;  // steps per second
  uint8_t count;
  Pose poses[4];
};
// Every preset ends facing forward, so the head never rests turned away.
const Preset presets[] = {
  {"center", 80, 1, {{0, 0, 0}}},
  {"nod", 200, 4, {{0, -0.45f, 0}, {0, 0.1f, 0}, {0, -0.45f, 0}, {0, 0, 0}}},
  {"shake", 200, 4, {{0.35f, 0, 0}, {-0.35f, 0, 0}, {0.35f, 0, 0}, {0, 0, 0}}},
  {"look_left", 120, 2, {{0.8f, 0, 1200}, {0, 0, 0}}},
  {"look_right", 120, 2, {{-0.8f, 0, 1200}, {0, 0, 0}}},
  {"look_up", 120, 2, {{0, 0.7f, 1200}, {0, 0, 0}}},
};

Preferences store;
Calibration cal{};
bool haveCal = false, calibrating = false;
const Preset *running = nullptr;
uint8_t pose = 0;
bool travelling = false;
uint32_t holdUntil = 0, panFaults = 0, tiltFaults = 0;

// Both ends on opposite sides of the centre, each at least minSide steps away.
bool spans(int center, int a, int b) {
  return (a - center) * (b - center) < 0 && abs(a - center) >= minSide && abs(b - center) >= minSide;
}
const char *check(const Calibration &c) {
  if (!spans(c.panCenter, c.left, c.right))
    return "pan: left and right must be on opposite sides, 20+ steps from center";
  if (!spans(c.tiltCenter, c.up, c.down))
    return "tilt: up and down must be on opposite sides, 20+ steps from center";
  return nullptr;
}

void applyRanges() {
  if (calibrating) {
    servo::setRange(panServo, lowest, highest, calibrationJump);
    servo::setRange(tiltServo, lowest, highest, calibrationJump);
  } else if (haveCal) {
    servo::setRange(panServo, min(cal.left, cal.right), max(cal.left, cal.right));
    servo::setRange(tiltServo, min(cal.up, cal.down), max(cal.up, cal.down));
  } else {
    servo::setRange(panServo, servo::softLow, servo::softHigh);
    servo::setRange(tiltServo, servo::softLow, servo::softHigh);
  }
}

uint16_t along(uint16_t center, uint16_t plusEnd, uint16_t minusEnd, float share) {
  const int end = share >= 0 ? plusEnd : minusEnd;
  return uint16_t(lroundf(center + fabsf(share) * float(end - int(center))));
}

bool sendPose() {
  const Pose &p = running->poses[pose];
  servo::MoveOptions options;
  options.speed = running->speed;
  options.tolerance = pose + 1 == running->count ? 3 : passTolerance;
  options.report = false;
  return servo::move(panServo, along(cal.panCenter, cal.left, cal.right, p.pan), options) ==
           servo::MoveResult::Started &&
         servo::move(tiltServo, along(cal.tiltCenter, cal.up, cal.down, p.tilt), options) ==
           servo::MoveResult::Started;
}

void finish(Print &out, const char *how) {
  out.printf("EVENT motion %s %s\n", running->name, how);
  running = nullptr;
}
}

void begin() {
  store.begin("otter-head", false);
  Stored saved{};
  haveCal = store.getBytesLength("cal") == sizeof(saved) && store.getBytes("cal", &saved, sizeof(saved)) &&
            saved.version == calibrationVersion && !check(saved.cal);
  if (haveCal) cal = saved.cal;
  applyRanges();
}

const char *state() {
  return calibrating ? "calibrating" : haveCal ? "calibrated" : "uncalibrated";
}

void report(Print &out) {
  if (!haveCal) {
    out.printf("{\"head\":\"%s\"}\n", state());
    return;
  }
  out.printf(
    "{\"head\":\"%s\",\"pan\":{\"servo\":%u,\"left\":%u,\"center\":%u,\"right\":%u},"
    "\"tilt\":{\"servo\":%u,\"up\":%u,\"center\":%u,\"down\":%u}}\n",
    state(), panServo, cal.left, cal.panCenter, cal.right, tiltServo, cal.up, cal.tiltCenter, cal.down);
}

void listMotions(Print &out) {
  out.print("{\"motions\":[");
  for (size_t i = 0; i < sizeof(presets) / sizeof(presets[0]); i++)
    out.printf(i ? ",\"%s\"" : "\"%s\"", presets[i].name);
  out.println("]}");
}

void startCalibration(Print &out) {
  cancel(out);
  calibrating = true;
  applyRanges();
}

const char *save(const long values[6]) {
  for (int i = 0; i < 6; i++)
    if (values[i] < lowest || values[i] > highest) return "positions must be within 20..1003";
  const Calibration c{uint16_t(values[0]), uint16_t(values[1]), uint16_t(values[2]),
                      uint16_t(values[3]), uint16_t(values[4]), uint16_t(values[5])};
  if (const char *problem = check(c)) return problem;
  const Stored saved{calibrationVersion, c};
  if (store.putBytes("cal", &saved, sizeof(saved)) != sizeof(saved)) return "could not store";
  cal = c;
  haveCal = true;
  calibrating = false;
  applyRanges();
  return nullptr;
}

void cancelCalibration() {
  calibrating = false;
  applyRanges();
}

void forget() {
  store.remove("cal");
  haveCal = false;
  applyRanges();
}

Result motion(const char *name, Print &out) {
  if (calibrating) return Result::Calibrating;
  if (!haveCal) return Result::NotCalibrated;
  const Preset *preset = nullptr;
  for (const Preset &p : presets)
    if (strcmp(p.name, name) == 0) preset = &p;
  if (!preset) return Result::Unknown;
  cancel(out);
  running = preset;
  pose = 0;
  panFaults = servo::faults(panServo);
  tiltFaults = servo::faults(tiltServo);
  if (!sendPose()) {
    servo::stopAll();
    finish(out, "failed");
    return Result::ServoError;
  }
  travelling = true;
  return Result::Started;
}

void cancel(Print &out) {
  if (running) finish(out, "stopped");
}

void update(uint32_t now, Print &out) {
  if (!running) return;
  if (servo::faults(panServo) != panFaults || servo::faults(tiltServo) != tiltFaults) {
    servo::stopAll();  // the faulted servo is already released; hold the other
    return finish(out, "failed");
  }
  if (travelling) {
    if (!servo::settled(panServo) || !servo::settled(tiltServo)) return;
    travelling = false;
    holdUntil = now + running->poses[pose].holdMs;
  }
  if (int32_t(now - holdUntil) < 0) return;
  if (++pose >= running->count) return finish(out, "done");
  if (!sendPose()) {
    servo::stopAll();
    return finish(out, "failed");
  }
  travelling = true;
}
}
