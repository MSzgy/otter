// Lessons 2-6: the physical screen can blink, react to a screen tap, play short
// built-in sounds, read the bus servos and move them slowly within a software
// range, and accept bounded USB commands. No Wi-Fi, credentials, or battery control.
#include <Arduino.h>
#include <Wire.h>
#include <esp_heap_caps.h>
#include <cstdlib>
#include <cstring>
#include "display.h"
#include "face.h"
#include "servo.h"
#include "sound.h"

constexpr uint32_t happyDurationMs = 2800;
constexpr uint32_t framePeriodMs = 50;  // 20 frames per second.
uint16_t *framebuffer = nullptr;
Mood baseMood = Mood::Idle;
uint32_t happyUntil = 0, blinkUntil = 0, lastFrame = 0, lastTouchPoll = 0;
uint32_t touches = 0;
bool touchAvailable = false, wasTouched = false, audioAvailable = false;
char commandBuffer[96];
size_t commandLength = 0;
bool discardCommand = false;

bool pending(uint32_t now, uint32_t deadline) {
  return deadline != 0 && int32_t(deadline - now) > 0;
}
Mood currentMood(uint32_t now) {
  return pending(now, happyUntil) ? Mood::Happy : baseMood;
}

// V2 uses CST3530, not V1's CST328. The bus and register layout are from the
// vendor V2 Touch_CST3530 example; the first lesson only needs contact/no contact.
constexpr uint8_t touchAddress = 0x58;
bool touchRegister(uint32_t reg, bool stop = true) {
  Wire1.beginTransmission(touchAddress);
  for (int shift = 24; shift >= 0; shift -= 8) Wire1.write(uint8_t(reg >> shift));
  return Wire1.endTransmission(stop) == 0;
}
void initTouch() {
  Wire1.begin(1, 3, 400000);
  Wire1.setTimeOut(20);
  pinMode(4, INPUT);
  pinMode(2, OUTPUT);
  digitalWrite(2, LOW);
  delay(100);
  digitalWrite(2, HIGH);
  delay(500);
  Wire1.beginTransmission(touchAddress);
  touchAvailable = Wire1.endTransmission() == 0;
}
int readTouch() {
  uint8_t data[9];
  if (!touchRegister(0xd0070000, false)) return -1;
  if (Wire1.requestFrom(touchAddress, uint8_t(sizeof(data))) != sizeof(data)) {
    touchRegister(0xd00002ab);
    return -1;
  }
  for (uint8_t &value : data) value = Wire1.read();
  touchRegister(0xd00002ab);
  const uint8_t count = data[3] & 0x0f;
  return count > 0 && count <= 5 && (data[8] & 0xf0) != 0;
}

void reportInfo() {
  Serial.printf(
    "{\"firmware\":\"otter-face-0.4.0\",\"board\":\"ESP32-S3-Touch-LCD-2.8-V2\","
    "\"width\":240,\"height\":320,\"flash_bytes\":%lu,\"psram_bytes\":%lu,"
    "\"touch_available\":%s,\"audio_available\":%s,\"touches\":%lu,\"mood\":\"%s\"}\n",
    (unsigned long)ESP.getFlashChipSize(), (unsigned long)ESP.getPsramSize(),
    touchAvailable ? "true" : "false", audioAvailable ? "true" : "false",
    (unsigned long)touches, moodName(currentMood(millis())));
}
// Parses exactly `count` space-separated decimal numbers; anything else fails.
bool parseNumbers(const char *text, long *values, int count) {
  for (int i = 0; i < count; i++) {
    char *end = nullptr;
    values[i] = strtol(text, &end, 10);
    if (end == text || (*end && *end != ' ')) return false;
    text = end;
  }
  return *text == '\0';
}

void handleCommand(const char *command) {
  if (strcmp(command, "PING") == 0) {
    Serial.println("PONG");
  } else if (strcmp(command, "INFO") == 0) {
    reportInfo();
  } else if (strcmp(command, "BLINK") == 0) {
    blinkUntil = millis() + 180;
    Serial.println("OK BLINK");
  } else if (strcmp(command, "FACE happy") == 0) {
    happyUntil = millis() + happyDurationMs;
    Serial.println("OK FACE happy");
  } else if (strncmp(command, "FACE ", 5) == 0) {
    const char *name = command + 5;
    if (strcmp(name, "idle") == 0) baseMood = Mood::Idle;
    else if (strcmp(name, "sleeping") == 0) baseMood = Mood::Sleeping;
    else if (strcmp(name, "thinking") == 0) baseMood = Mood::Thinking;
    else if (strcmp(name, "speaking") == 0) baseMood = Mood::Speaking;
    else { Serial.println("ERR unsupported face"); return; }
    happyUntil = 0;
    Serial.printf("OK FACE %s\n", name);
  } else if (strncmp(command, "SOUND ", 6) == 0) {
    const char *name = command + 6;
    switch (sound::play(name)) {
      case sound::Result::Queued: Serial.printf("OK SOUND %s\n", name); break;
      case sound::Result::Busy: Serial.println("ERR sound busy"); break;
      case sound::Result::Unavailable: Serial.println("ERR sound unavailable"); break;
      default: Serial.println("ERR unsupported sound");
    }
  } else if (strncmp(command, "SERVO MOVE ", 11) == 0 || strncmp(command, "SERVO CENTER ", 13) == 0) {
    const bool toCenter = command[6] == 'C';
    long values[2];
    if (!parseNumbers(command + (toCenter ? 13 : 11), values, toCenter ? 1 : 2) || values[0] < 0 ||
        values[0] > 253 || (!toCenter && (values[1] < 0 || values[1] > 1023))) {
      Serial.println("ERR invalid servo command");
      return;
    }
    switch (servo::move(uint8_t(values[0]), toCenter ? servo::center : uint16_t(values[1]))) {
      case servo::MoveResult::Started: Serial.printf("OK %s\n", command); break;
      case servo::MoveResult::UnknownServo: Serial.println("ERR unknown servo"); break;
      case servo::MoveResult::OutOfRange:
        Serial.printf("ERR servo target outside %u..%u\n", servo::softLow, servo::softHigh);
        break;
      case servo::MoveResult::NoReply: Serial.printf("ERR servo %ld no reply\n", values[0]); break;
      case servo::MoveResult::Unsafe: Serial.printf("ERR servo %ld unsafe, released\n", values[0]); break;
    }
  } else if (strncmp(command, "SERVO RELEASE ", 14) == 0) {
    long id;
    if (!parseNumbers(command + 14, &id, 1) || id < 0 || id > 253) Serial.println("ERR invalid servo id");
    else if (!servo::release(uint8_t(id))) Serial.printf("ERR servo %ld no reply\n", id);
    else Serial.printf("OK %s\n", command);
  } else if (strcmp(command, "SERVO STOP") == 0) {
    servo::stopAll();
    Serial.println("OK SERVO STOP");
  } else if (strcmp(command, "SERVO SCAN") == 0) {
    // Blocks for about a second, which would pause motion checks, so not while moving.
    if (servo::moving()) {
      Serial.println("ERR servo busy");
      return;
    }
    uint8_t ids[16];
    const size_t count = servo::scan(ids, sizeof(ids));
    Serial.print("{\"servos\":[");
    for (size_t i = 0; i < count; i++) Serial.printf(i ? ",%u" : "%u", ids[i]);
    Serial.println("]}");
  } else if (strcmp(command, "SERVO PINS") == 0) {
    if (servo::holding()) {  // the probe detaches the UART for a moment
      Serial.println("ERR servo busy");
      return;
    }
    int levels[4];
    servo::probePins(levels);
    Serial.printf("PINS gpio43 down=%d up=%d gpio44 down=%d up=%d\n", levels[0], levels[1],
                  levels[2], levels[3]);
  } else if (strncmp(command, "SERVO RAW ", 10) == 0) {
    long id;
    if (!parseNumbers(command + 10, &id, 1) || id < 0 || id > 253) {
      Serial.println("ERR invalid servo id");
    } else {
      uint8_t received[32];
      const size_t n = servo::rawPing(uint8_t(id), received, sizeof(received));
      Serial.printf("RAW %ld got %u bytes:", id, unsigned(n));
      for (size_t i = 0; i < n; i++) Serial.printf(" %02x", received[i]);
      Serial.println();
    }
  } else if (strncmp(command, "SERVO STATUS ", 13) == 0) {
    long id;
    servo::Status status;
    if (!parseNumbers(command + 13, &id, 1) || id < 0 || id > 253) {
      Serial.println("ERR invalid servo id");
    } else if (!servo::readStatus(uint8_t(id), status)) {
      Serial.printf("ERR servo %ld no reply\n", id);
    } else {
      Serial.printf("{\"servo\":%ld,\"pos\":%u,\"load\":%u,\"volts\":%.1f,\"temp\":%u,\"torque\":%s}\n",
                    id, status.position, status.load, status.volts, status.temperature,
                    status.torque ? "true" : "false");
    }
  } else if (strcmp(command, "HELP") == 0) {
    Serial.println("PING | INFO | BLINK | FACE idle/happy/sleeping/thinking/speaking | SOUND beep/chirp"
                   " | SERVO SCAN | SERVO STATUS <id> | SERVO MOVE <id> <pos> | SERVO CENTER <id>"
                   " | SERVO RELEASE <id> | SERVO STOP | SERVO RAW <id> | SERVO PINS");
  } else if (command[0]) {
    Serial.println("ERR unknown command");
  }
}
void pollSerial() {
  // Bound work per loop, so a fast sender cannot starve screen refresh.
  for (int count = 0; count < 128 && Serial.available(); count++) {
    const char ch = char(Serial.read());
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (!discardCommand) {
        commandBuffer[commandLength] = '\0';
        handleCommand(commandBuffer);
      }
      commandLength = 0;
      discardCommand = false;
    } else if (!discardCommand) {
      if (ch == '\0' || commandLength >= sizeof(commandBuffer) - 1) {
        discardCommand = true;
        Serial.println("ERR invalid or oversized line");
      } else commandBuffer[commandLength++] = ch;
    }
  }
}

void setup() {
  Serial.begin(115200);
  framebuffer = static_cast<uint16_t *>(heap_caps_malloc(
    screen::width * screen::height * sizeof(uint16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!framebuffer) framebuffer = static_cast<uint16_t *>(malloc(screen::width * screen::height * sizeof(uint16_t)));
  if (!framebuffer) {
    Serial.println("ERR no framebuffer memory");
    return;
  }
  screen::begin();
  drawFace(framebuffer, Mood::Idle, millis(), false);
  screen::present(framebuffer);
  initTouch();
  audioAvailable = sound::begin();
  servo::begin();
  Serial.println("OTTER FACE READY");
}

void loop() {
  pollSerial();
  const uint32_t now = millis();
  if (touchAvailable && now - lastTouchPoll >= 40) {
    lastTouchPoll = now;
    const int contact = readTouch();
    if (contact >= 0) {
      if (contact && !wasTouched) {
        touches++;
        baseMood = Mood::Idle;
        happyUntil = now + happyDurationMs;
        sound::play("chirp");  // Local reflex; if a clip is still playing, this tap stays quiet.
        Serial.printf("EVENT screen_touch %lu\n", (unsigned long)touches);
      }
      wasTouched = contact != 0;
    }
  }
  servo::update(now, Serial);
  if (framebuffer && now - lastFrame >= framePeriodMs) {
    lastFrame = now;
    drawFace(framebuffer, currentMood(now), now, pending(now, blinkUntil));
    screen::present(framebuffer);
  }
  delay(2);
}
