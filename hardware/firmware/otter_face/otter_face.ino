// Lessons 2-3: the physical screen can blink, react to a screen tap, play short
// built-in sounds, and accept bounded USB commands. No motors, Wi-Fi,
// credentials, or battery control.
#include <Arduino.h>
#include <Wire.h>
#include <esp_heap_caps.h>
#include <cstring>
#include "display.h"
#include "face.h"
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
    "{\"firmware\":\"otter-face-0.2.0\",\"board\":\"ESP32-S3-Touch-LCD-2.8-V2\","
    "\"width\":240,\"height\":320,\"flash_bytes\":%lu,\"psram_bytes\":%lu,"
    "\"touch_available\":%s,\"audio_available\":%s,\"touches\":%lu,\"mood\":\"%s\"}\n",
    (unsigned long)ESP.getFlashChipSize(), (unsigned long)ESP.getPsramSize(),
    touchAvailable ? "true" : "false", audioAvailable ? "true" : "false",
    (unsigned long)touches, moodName(currentMood(millis())));
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
  } else if (strcmp(command, "HELP") == 0) {
    Serial.println("PING | INFO | BLINK | FACE idle/happy/sleeping/thinking/speaking | SOUND beep/chirp");
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
        Serial.printf("EVENT screen_touch %lu\n", (unsigned long)touches);
      }
      wasTouched = contact != 0;
    }
  }
  if (framebuffer && now - lastFrame >= framePeriodMs) {
    lastFrame = now;
    drawFace(framebuffer, currentMood(now), now, pending(now, blinkUntil));
    screen::present(framebuffer);
  }
  delay(2);
}
