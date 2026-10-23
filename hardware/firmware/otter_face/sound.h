#pragma once
#include <Arduino.h>

namespace sound {
enum class Result { Queued, Busy, Unknown, Unavailable };

// Starts I2S output to the onboard PCM5101 and a playback task on core 0.
// Returns false if audio could not start; the face keeps working without it.
bool begin();
// Queues one allowlisted clip by name. Only one clip plays at a time.
Result play(const char *name);
}
