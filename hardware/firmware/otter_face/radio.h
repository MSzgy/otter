#pragma once
#include <Arduino.h>

// Lesson 10: look at nearby Wi-Fi without joining anything. The radio stays off
// except during a scan; no network is joined and nothing is stored.
namespace radio {
bool startScan();  // false if a scan is already running or the radio failed to start
bool scanning();
void update(Print &out);  // prints {"wifi":[...]} when a scan ends, then turns the radio off
}
