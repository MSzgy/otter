#pragma once
#include <Arduino.h>

namespace sound {
enum class Result { Queued, Busy, Unknown, Unavailable };

// Starts I2S output to the onboard PCM5101 and a playback task on core 0, and loads
// the voice pack (scripts/build-voice-pack.py) if one is in flash. Returns false if
// audio could not start; the face keeps working without it.
bool begin();
// Queues one built-in tone by name. Refused while anything is playing.
Result play(const char *name);

// Voice lines: one short 16 kHz clip per expression, streamed from flash.
size_t voiceCount();  // 0 when no voice pack is present
const char *voiceName(size_t index);
// interrupt=true stops whatever is playing so only the newest line is heard;
// interrupt=false is refused (Busy) while anything is playing.
Result say(const char *name, bool interrupt = true);
void stop();
}
