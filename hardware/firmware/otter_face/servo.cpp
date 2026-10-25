#include "servo.h"
#include <cstdlib>
#include <cstring>

// Bus Servo Adapter (A) with its jumper on A. Waveshare wires it same-name:
// ESP32 GPIO43 -> adapter TX, GPIO44 -> adapter RX, plus a shared ground.
// SC-series servos at their factory 1 Mbps; 16-bit values are high byte first.
// Writes are limited to torque enable (40) and goal position/time/speed (42-47).
namespace servo {
namespace {
constexpr int pinTx = 43, pinRx = 44;
constexpr uint32_t baud = 1000000;
constexpr uint8_t instrPing = 0x01, instrRead = 0x02, instrWrite = 0x03;
constexpr uint8_t addrLimits = 9, addrTorque = 40, addrGoal = 42, addrStatus = 56;
constexpr uint32_t scanWindowUs = 2000, readWindowUs = 5000;

constexpr uint16_t stallLoad = 400;          // normal moves read 0..120
constexpr uint8_t stallPolls = 3;            // sustained for 3 polls before releasing
constexpr int blockedSteps = 15;
constexpr uint32_t movePollMs = 50, holdPollMs = 500, idleReleaseMs = 20000;
// Settled = moved at most 1 step in this long. Even at lesson 6's 40 steps/s a moving
// servo covers 16 steps here; polls 50 ms apart can read the same position.
constexpr uint32_t settleMs = 400;
constexpr float minVolts = 4.5f, maxVolts = 6.2f;
constexpr uint8_t maxTemp = 50;
HardwareSerial &bus = Serial1;

struct Motion {
  explicit Motion(uint8_t servoId) : id(servoId) {}
  uint8_t id;
  bool active = false, holding = false, goalSent = false;
  uint16_t target = 0, anchorPosition = 0;
  uint32_t sendAt = 0, deadlineMs = 0, lastPollMs = 0, idleSinceMs = 0, anchorMs = 0;
  uint8_t overloadPolls = 0;
  MoveOptions options;
  uint16_t low = softLow, high = softHigh, maxJump = 0;
  uint32_t faults = 0;
};
Motion motions[] = {Motion(1), Motion(2)};

Motion *find(uint8_t id) {
  for (Motion &m : motions)
    if (m.id == id) return &m;
  return nullptr;
}

uint8_t checksum(const uint8_t *body, size_t length) {
  uint8_t sum = 0;
  for (size_t i = 0; i < length; i++) sum += body[i];
  return ~sum;
}

// Returns the payload length of a valid reply from `id`, -1 if `data` holds no
// complete reply yet. Skips an echo of our own request, which half-duplex
// adapters can produce.
int parse(const uint8_t *data, size_t n, const uint8_t *request, size_t requestLength,
          uint8_t id, uint8_t *payload, size_t capacity) {
  size_t start = n >= requestLength && memcmp(data, request, requestLength) == 0 ? requestLength : 0;
  while (start + 1 < n && !(data[start] == 0xff && data[start + 1] == 0xff)) start++;
  if (start + 4 > n) return -1;
  const size_t end = start + 4 + data[start + 3];
  if (end > n || data[start + 3] < 2) return -1;
  if (data[start + 2] != id || checksum(data + start + 2, end - start - 3) != data[end - 1]) return -1;
  const size_t length = end - start - 6;  // drop FF FF, id, length, error byte, checksum
  if (length > capacity) return -1;
  memcpy(payload, data + start + 5, length);
  return int(length);
}

int transact(uint8_t id, uint8_t instruction, const uint8_t *params, uint8_t count,
             uint8_t *payload, size_t capacity, uint32_t windowUs) {
  uint8_t request[16];
  if (count > sizeof(request) - 6) return -1;
  request[0] = request[1] = 0xff;
  request[2] = id;
  request[3] = count + 2;
  request[4] = instruction;
  if (count) memcpy(request + 5, params, count);
  request[5 + count] = checksum(request + 2, 3 + count);
  const size_t requestLength = 6 + count;

  while (bus.available()) bus.read();
  bus.write(request, requestLength);
  bus.flush();
  uint8_t data[48];
  size_t n = 0;
  const uint32_t started = micros();
  while (micros() - started < windowUs) {
    while (bus.available() && n < sizeof(data)) data[n++] = uint8_t(bus.read());
    const int length = parse(data, n, request, requestLength, id, payload, capacity);
    if (length >= 0) return length;
  }
  return -1;
}

// Replies are occasionally lost, so reads and writes retry a few times.
bool read(uint8_t id, uint8_t address, uint8_t count, uint8_t *out) {
  const uint8_t params[] = {address, count};
  for (int attempt = 0; attempt < 4; attempt++) {
    if (transact(id, instrRead, params, sizeof(params), out, count, readWindowUs) == count) return true;
  }
  return false;
}

bool write(uint8_t id, const uint8_t *params, uint8_t count) {
  uint8_t unused[1];
  for (int attempt = 0; attempt < 4; attempt++) {
    if (transact(id, instrWrite, params, count, unused, sizeof(unused), readWindowUs) >= 0) return true;
  }
  return false;
}

bool writeTorque(uint8_t id, bool on) {
  const uint8_t params[] = {addrTorque, uint8_t(on)};
  return write(id, params, sizeof(params));
}

bool writeGoal(uint8_t id, uint16_t position, uint16_t speed) {
  // Goal position, time 0 (so speed governs), speed; all high byte first.
  const uint8_t params[] = {addrGoal, uint8_t(position >> 8), uint8_t(position), 0, 0,
                            uint8_t(speed >> 8), uint8_t(speed)};
  return write(id, params, sizeof(params));
}

bool safe(const Status &s) {
  return s.volts >= minVolts && s.volts <= maxVolts && s.temperature <= maxTemp;
}

void fail(Motion &m, Print &out, const char *reason, const Status *s) {
  release(m.id);
  m.faults++;
  if (s)
    out.printf("EVENT servo %u fault %s pos %u load %u %.1fV %uC\n", m.id, reason, s->position,
               s->load, s->volts, s->temperature);
  else
    out.printf("EVENT servo %u fault %s\n", m.id, reason);
}

void step(Motion &m, uint32_t now, Print &out) {
  if (!m.holding) return;
  if (m.active && !m.goalSent) {
    if (int32_t(now - m.sendAt) < 0) return;
    if (!writeGoal(m.id, m.target, m.options.speed)) return fail(m, out, "no-reply", nullptr);
    m.goalSent = true;
    m.lastPollMs = m.anchorMs = now;
    return;
  }
  if (now - m.lastPollMs < (m.active ? movePollMs : holdPollMs)) return;
  m.lastPollMs = now;

  Status s;
  if (!readStatus(m.id, s)) return fail(m, out, "no-reply", nullptr);
  if (!safe(s)) return fail(m, out, "unsafe", &s);
  m.overloadPolls = s.load > stallLoad ? m.overloadPolls + 1 : 0;
  if (m.overloadPolls >= stallPolls) return fail(m, out, "stalled", &s);

  if (m.active) {
    if (abs(int(s.position) - int(m.anchorPosition)) > 1) {
      m.anchorPosition = s.position;
      m.anchorMs = now;
    }
    const int diff = int(s.position) - int(m.target);
    if (abs(diff) <= m.options.tolerance || now - m.anchorMs >= settleMs) {
      // A few steps short is normal: the last steps can't beat gear friction.
      if (abs(diff) > blockedSteps) return fail(m, out, "blocked", &s);
      m.active = false;
      m.idleSinceMs = now;
      if (m.options.report) out.printf("EVENT servo %u arrived %u diff %+d\n", m.id, s.position, diff);
    } else if (int32_t(now - m.deadlineMs) > 0) {
      fail(m, out, "timeout", &s);
    }
  } else if (now - m.idleSinceMs > idleReleaseMs) {
    release(m.id);
    out.printf("EVENT servo %u released idle\n", m.id);
  }
}
}

void begin() {
  bus.begin(baud, SERIAL_8N1, pinRx, pinTx);
}

void probePins(int levels[4]) {
  // Inputs only, nothing is driven: a pin wired to the adapter's output reads 1
  // with either pull, a pin left floating follows the pull.
  bus.end();
  const int pins[] = {pinTx, pinRx};
  for (int i = 0; i < 2; i++) {
    pinMode(pins[i], INPUT_PULLDOWN);
    delay(5);
    levels[i * 2] = digitalRead(pins[i]);
    pinMode(pins[i], INPUT_PULLUP);
    delay(5);
    levels[i * 2 + 1] = digitalRead(pins[i]);
    pinMode(pins[i], INPUT);
  }
  begin();
}

size_t rawPing(uint8_t id, uint8_t *received, size_t capacity) {
  const uint8_t body[] = {id, 2, instrPing};
  const uint8_t request[] = {0xff, 0xff, id, 2, instrPing, checksum(body, sizeof(body))};
  while (bus.available()) bus.read();
  bus.write(request, sizeof(request));
  bus.flush();
  size_t n = 0;
  const uint32_t started = micros();
  while (micros() - started < 10000) {
    while (bus.available() && n < capacity) received[n++] = uint8_t(bus.read());
  }
  return n;
}

size_t scan(uint8_t *ids, size_t capacity) {
  size_t found = 0;
  uint8_t unused[1];
  for (int id = 0; id <= 253 && found < capacity; id++) {
    for (int attempt = 0; attempt < 2; attempt++) {
      if (transact(uint8_t(id), instrPing, nullptr, 0, unused, sizeof(unused), scanWindowUs) >= 0) {
        ids[found++] = uint8_t(id);
        break;
      }
    }
  }
  return found;
}

bool readStatus(uint8_t id, Status &status) {
  uint8_t live[8], torque[1];
  if (!read(id, addrStatus, sizeof(live), live) || !read(id, addrTorque, sizeof(torque), torque))
    return false;
  status.position = uint16_t(live[0] << 8 | live[1]);
  status.speed = uint16_t((live[2] << 8 | live[3]) & 0x7fff);  // bit 15 is direction
  status.load = uint16_t((live[4] << 8 | live[5]) & 0x3ff);
  status.volts = live[6] / 10.0f;
  status.temperature = live[7];
  status.torque = torque[0] != 0;
  return true;
}

MoveResult move(uint8_t id, uint16_t target, const MoveOptions &options) {
  Motion *m = find(id);
  if (!m) return MoveResult::UnknownServo;
  if (target < m->low || target > m->high || options.speed == 0) return MoveResult::OutOfRange;
  uint8_t limits[4];
  if (!read(id, addrLimits, sizeof(limits), limits)) return MoveResult::NoReply;
  if (target < (limits[0] << 8 | limits[1]) || target > (limits[2] << 8 | limits[3]))
    return MoveResult::OutOfRange;
  Status s;
  if (!readStatus(id, s)) return MoveResult::NoReply;
  if (!safe(s)) {
    release(id);
    return MoveResult::Unsafe;
  }
  if (m->maxJump && uint16_t(abs(int(target) - int(s.position))) > m->maxJump) return MoveResult::TooFar;
  const uint32_t now = millis();
  if (!s.torque) {
    // Goal = where it already is, so turning torque on cannot make it jump.
    if (!writeGoal(id, s.position, options.speed) || !writeTorque(id, true)) {
      release(id);
      return MoveResult::NoReply;
    }
  }
  m->active = m->holding = true;
  m->goalSent = false;
  m->target = target;
  m->options = options;
  m->anchorPosition = s.position;
  m->sendAt = now + (s.torque ? 0 : 100);  // the first goal right after torque-on was once ignored
  m->deadlineMs = now + uint32_t(abs(int(target) - int(s.position))) * 1000 / options.speed + 2000;
  m->lastPollMs = m->anchorMs = now;
  m->overloadPolls = 0;
  return MoveResult::Started;
}

bool release(uint8_t id) {
  if (Motion *m = find(id)) m->active = m->holding = false;
  return writeTorque(id, false);
}

void setRange(uint8_t id, uint16_t low, uint16_t high, uint16_t maxJump) {
  if (Motion *m = find(id)) {
    m->low = low;
    m->high = high;
    m->maxJump = maxJump;
  }
}

bool range(uint8_t id, uint16_t &low, uint16_t &high) {
  const Motion *m = find(id);
  if (!m) return false;
  low = m->low;
  high = m->high;
  return true;
}

bool settled(uint8_t id) {
  const Motion *m = find(id);
  return m && m->holding && !m->active;
}

uint32_t faults(uint8_t id) {
  const Motion *m = find(id);
  return m ? m->faults : 0;
}

void stopAll() {
  for (Motion &m : motions) {
    if (!m.holding) continue;
    Status s;
    if (!readStatus(m.id, s) || !writeGoal(m.id, s.position, m.options.speed)) {
      release(m.id);
      continue;
    }
    m.active = false;
    m.idleSinceMs = millis();
  }
}

bool moving() {
  for (const Motion &m : motions)
    if (m.active) return true;
  return false;
}

bool holding() {
  for (const Motion &m : motions)
    if (m.holding) return true;
  return false;
}

void update(uint32_t now, Print &out) {
  for (Motion &m : motions) step(m, now, out);
}
}
