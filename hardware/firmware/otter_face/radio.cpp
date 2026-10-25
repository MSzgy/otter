#include "radio.h"
#include <WiFi.h>

namespace radio {
namespace {
constexpr int maxListed = 20;
constexpr uint32_t scanTimeoutMs = 15000;
bool running = false;
uint32_t startedMs = 0;

// SSIDs are arbitrary bytes: escape what JSON requires, pass UTF-8 through.
void printJsonString(Print &out, const String &text) {
  out.print('"');
  for (size_t i = 0; i < text.length(); i++) {
    const uint8_t c = uint8_t(text[i]);
    if (c == '"' || c == '\\') {
      out.print('\\');
      out.print(char(c));
    } else if (c < 0x20 || c == 0x7f) {
      out.printf("\\u%04x", c);
    } else {
      out.print(char(c));
    }
  }
  out.print('"');
}

void radioOff() {
  WiFi.scanDelete();
  WiFi.mode(WIFI_OFF);
  running = false;
}
}

bool startScan() {
  if (running) return false;
  WiFi.persistent(false);  // never write Wi-Fi settings to flash
  if (!WiFi.mode(WIFI_STA)) return false;
  if (WiFi.scanNetworks(true) == WIFI_SCAN_FAILED) {
    radioOff();
    return false;
  }
  running = true;
  startedMs = millis();
  return true;
}

bool scanning() {
  return running;
}

void update(Print &out) {
  if (!running) return;
  const int16_t found = WiFi.scanComplete();
  if (found == WIFI_SCAN_RUNNING && millis() - startedMs < scanTimeoutMs) return;
  if (found < 0) {
    out.println("EVENT wifi scan failed");
    return radioOff();
  }
  // Strongest first; only the first maxListed are printed.
  int order[64];
  const int count = found < 64 ? found : 64;
  for (int i = 0; i < count; i++) {
    int j = i;
    while (j > 0 && WiFi.RSSI(order[j - 1]) < WiFi.RSSI(i)) {
      order[j] = order[j - 1];
      j--;
    }
    order[j] = i;
  }
  out.print("{\"wifi\":[");
  for (int k = 0; k < count && k < maxListed; k++) {
    const int i = order[k];
    out.print(k ? ",{\"ssid\":" : "{\"ssid\":");
    printJsonString(out, WiFi.SSID(i));
    out.printf(",\"rssi\":%d,\"channel\":%d,\"secure\":%s}", int(WiFi.RSSI(i)), int(WiFi.channel(i)),
               WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "false" : "true");
  }
  out.printf("],\"found\":%d}\n", int(found));
  radioOff();
}
}
