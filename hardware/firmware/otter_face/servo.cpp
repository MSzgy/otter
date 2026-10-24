#include "servo.h"
#include <cstring>

// Bus Servo Adapter (A) with its jumper on A. Waveshare wires it same-name:
// ESP32 GPIO43 -> adapter TX, GPIO44 -> adapter RX, plus a shared ground.
// SC-series servos at their factory 1 Mbps; 16-bit values are high byte first.
namespace servo {
namespace {
constexpr int pinTx = 43, pinRx = 44;
constexpr uint32_t baud = 1000000;
constexpr uint8_t instrPing = 0x01, instrRead = 0x02;
constexpr uint8_t addrTorque = 40, addrStatus = 56;
constexpr uint32_t scanWindowUs = 2000, readWindowUs = 5000;
HardwareSerial &bus = Serial1;

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
  uint8_t request[8];
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

// Replies are occasionally lost, so reads retry a few times.
bool read(uint8_t id, uint8_t address, uint8_t count, uint8_t *out) {
  const uint8_t params[] = {address, count};
  for (int attempt = 0; attempt < 4; attempt++) {
    if (transact(id, instrRead, params, sizeof(params), out, count, readWindowUs) == count) return true;
  }
  return false;
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
  status.load = uint16_t((live[4] << 8 | live[5]) & 0x3ff);
  status.volts = live[6] / 10.0f;
  status.temperature = live[7];
  status.torque = torque[0] != 0;
  return true;
}
}
