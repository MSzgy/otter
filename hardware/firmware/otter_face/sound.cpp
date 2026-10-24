#include "sound.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <driver/i2s_std.h>
#include <esp_partition.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

// Pins checked against Waveshare's V2 example LVGL_Arduino/Audio_PCM5101.h.
// The PCM5101 derives its clock from BCLK, so MCLK is not wired. Tones are
// computed here; voice lines come from a pack in flash, so no SD card or network.
namespace sound {
namespace {
constexpr int pinBclk = 48, pinWs = 38, pinData = 47;
constexpr uint32_t sampleRate = 16000;  // the voice pack is 16 kHz too
constexpr float amplitude = 6000;              // About 18% of full scale; the board knob sets the rest.
constexpr uint32_t fadeSamples = sampleRate / 200;  // 5 ms ramps avoid clicks.
constexpr size_t chunkFrames = 256;

struct Note { uint16_t startHz, endHz, ms; };  // startHz 0 means silence.
struct Clip { const char *name; const Note *notes; size_t count; };

constexpr Note beepNotes[] = {{880, 880, 150}};
constexpr Note chirpNotes[] = {{660, 660, 90}, {0, 0, 30}, {990, 1320, 140}};
constexpr Clip clips[] = {
  {"beep", beepNotes, sizeof(beepNotes) / sizeof(beepNotes[0])},
  {"chirp", chirpNotes, sizeof(chirpNotes) / sizeof(chirpNotes[0])},
};

// Voice pack layout, written by scripts/build-voice-pack.py 2 MiB into the ffat
// partition, after the pixel animation pack. Clips are mono signed 16-bit LE PCM;
// they are normalised to about the chirp's loudness, so they play unscaled.
constexpr uint32_t voiceOffset = 0x200000;
constexpr size_t maxVoices = 32, voiceNameBytes = 24;
constexpr uint32_t maxVoiceBytes = sampleRate * 2 * 10;  // 10 s is far above any line
struct __attribute__((packed)) VoiceHeader {
  char magic[4];
  uint16_t version, count;
  uint32_t rate, reserved;
};
struct __attribute__((packed)) VoiceEntry {
  char name[voiceNameBytes];
  uint32_t offset, bytes;
};
static_assert(sizeof(VoiceHeader) == 16 && sizeof(VoiceEntry) == 32, "must match build-voice-pack.py");

struct Request {
  const Clip *tone;  // a built-in tone, or
  int voice;         // a voice clip index when tone is null
};

i2s_chan_handle_t tx = nullptr;
QueueHandle_t requests = nullptr;
std::atomic<bool> playing{false}, interrupted{false};
int16_t frames[chunkFrames * 2];  // Interleaved left/right; both get the same sample.
int16_t mono[chunkFrames];
const esp_partition_t *pack = nullptr;
VoiceEntry voices[maxVoices];
size_t voiceTotal = 0;

float envelope(uint32_t n, uint32_t total, uint32_t fade) {
  if (!fade) return 1.0f;
  const uint32_t edge = std::min(n, total - 1 - n);
  return edge >= fade ? 1.0f : float(edge) / fade;
}

void writeNote(const Note &note) {
  const uint32_t total = sampleRate * note.ms / 1000;
  const uint32_t fade = std::min(fadeSamples, total / 2);
  float phase = 0;
  for (uint32_t done = 0; done < total;) {
    const uint32_t count = std::min<uint32_t>(total - done, chunkFrames);
    for (uint32_t i = 0; i < count; i++) {
      const uint32_t n = done + i;
      float value = 0;
      if (note.startHz) {
        const float hz = note.startHz + (float(note.endHz) - note.startHz) * n / total;
        phase = fmodf(phase + 2.0f * float(PI) * hz / sampleRate, 2.0f * float(PI));
        value = sinf(phase) * amplitude * envelope(n, total, fade);
      }
      frames[2 * i] = frames[2 * i + 1] = int16_t(value);
    }
    size_t written = 0;
    i2s_channel_write(tx, frames, count * 2 * sizeof(int16_t), &written, portMAX_DELAY);
    done += count;
  }
}

// Streams a clip from flash a chunk at a time; never holds the whole clip in RAM.
void writeVoice(const VoiceEntry &v) {
  for (uint32_t done = 0; done < v.bytes && !interrupted;) {
    const uint32_t bytes = std::min<uint32_t>(v.bytes - done, sizeof(mono));
    if (esp_partition_read(pack, voiceOffset + v.offset + done, mono, bytes) != ESP_OK) return;
    const size_t count = bytes / 2;
    for (size_t i = 0; i < count; i++) frames[2 * i] = frames[2 * i + 1] = mono[i];
    size_t written = 0;
    i2s_channel_write(tx, frames, count * 2 * sizeof(int16_t), &written, portMAX_DELAY);
    done += bytes;
  }
}

// Runs on core 0 so writing audio never stalls the face loop on core 1.
void playback(void *) {
  Request request{};
  for (;;) {
    if (xQueueReceive(requests, &request, portMAX_DELAY) != pdTRUE) continue;
    interrupted = false;
    playing = true;
    if (request.tone) {
      for (size_t i = 0; i < request.tone->count && !interrupted; i++) writeNote(request.tone->notes[i]);
    } else {
      writeVoice(voices[request.voice]);
    }
    playing = false;
  }
}

bool validVoice(const VoiceEntry &v) {
  if (!v.name[0] || memchr(v.name, '\0', voiceNameBytes) == nullptr) return false;
  if (v.bytes == 0 || v.bytes % 2 || v.bytes > maxVoiceBytes) return false;
  const uint64_t end = uint64_t(voiceOffset) + v.offset + v.bytes;
  return end <= pack->size;
}

// Missing or malformed pack: no voices, tones still work.
void loadVoices() {
  pack = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, nullptr);
  VoiceHeader header;
  if (!pack || pack->size <= voiceOffset ||
      esp_partition_read(pack, voiceOffset, &header, sizeof(header)) != ESP_OK)
    return;
  if (memcmp(header.magic, "OTVO", 4) != 0 || header.version != 1 || header.rate != sampleRate ||
      header.count == 0 || header.count > maxVoices)
    return;
  if (esp_partition_read(pack, voiceOffset + sizeof(header), voices, header.count * sizeof(VoiceEntry)) != ESP_OK)
    return;
  for (size_t i = 0; i < header.count; i++)
    if (!validVoice(voices[i])) return;
  voiceTotal = header.count;
}
}

bool begin() {
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
  channel.auto_clear = true;  // Send silence whenever no clip is playing.
  if (i2s_new_channel(&channel, &tx, nullptr) != ESP_OK) return false;
  const i2s_std_config_t config = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = gpio_num_t(pinBclk),
      .ws = gpio_num_t(pinWs),
      .dout = gpio_num_t(pinData),
      .din = I2S_GPIO_UNUSED,
      .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
    },
  };
  if (i2s_channel_init_std_mode(tx, &config) != ESP_OK || i2s_channel_enable(tx) != ESP_OK) {
    i2s_del_channel(tx);
    tx = nullptr;
    return false;
  }
  requests = xQueueCreate(1, sizeof(Request));
  if (!requests || xTaskCreatePinnedToCore(playback, "sound", 4096, nullptr, 2, nullptr, 0) != pdPASS)
    return false;
  loadVoices();
  return true;
}

Result play(const char *name) {
  if (!tx || !requests) return Result::Unavailable;
  for (const Clip &clip : clips) {
    if (strcmp(name, clip.name) != 0) continue;
    const Request request{&clip, -1};
    if (playing || xQueueSend(requests, &request, 0) != pdTRUE) return Result::Busy;
    return Result::Queued;
  }
  return Result::Unknown;
}

size_t voiceCount() {
  return voiceTotal;
}

const char *voiceName(size_t index) {
  return index < voiceTotal ? voices[index].name : "";
}

Result say(const char *name, bool interrupt) {
  if (!tx || !requests || voiceTotal == 0) return Result::Unavailable;
  for (size_t i = 0; i < voiceTotal; i++) {
    if (strcmp(name, voices[i].name) != 0) continue;
    if (!interrupt && (playing || uxQueueMessagesWaiting(requests))) return Result::Busy;
    const Request request{nullptr, int(i)};
    if (interrupt) interrupted = true;  // the playback task stops at its next chunk
    xQueueOverwrite(requests, &request);
    return Result::Queued;
  }
  return Result::Unknown;
}

void stop() {
  if (!requests) return;
  xQueueReset(requests);
  interrupted = true;
}
}
