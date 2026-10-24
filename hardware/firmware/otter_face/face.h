#pragma once
#include <Arduino.h>
enum class Mood { Idle, Happy, Sleeping, Thinking, Speaking };
const char *moodName(Mood mood);
bool moodFromName(const char *name, Mood &mood);
void drawFace(uint16_t *pixels, Mood mood, uint32_t now, bool forcedBlink);
