#include "sound.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <driver/i2s_std.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

// Pins checked against Waveshare's V2 example LVGL_Arduino/Audio_PCM5101.h.
// The PCM5101 derives its clock from BCLK, so MCLK is not wired. Tones are
// computed here, so no audio files, SD card, or network are needed.
namespace sound {
namespace {
constexpr int pinBclk = 48, pinWs = 38, pinData = 47;
constexpr uint32_t sampleRate = 16000;
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

i2s_chan_handle_t tx = nullptr;
QueueHandle_t requests = nullptr;
std::atomic<bool> playing{false};
int16_t frames[chunkFrames * 2];  // Interleaved left/right; both get the same sample.

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

// Runs on core 0 so writing audio never stalls the face loop on core 1.
void playback(void *) {
  const Clip *clip = nullptr;
  for (;;) {
    if (xQueueReceive(requests, &clip, portMAX_DELAY) != pdTRUE) continue;
    playing = true;
    for (size_t i = 0; i < clip->count; i++) writeNote(clip->notes[i]);
    playing = false;
  }
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
  requests = xQueueCreate(1, sizeof(const Clip *));
  return requests && xTaskCreatePinnedToCore(playback, "sound", 4096, nullptr, 2, nullptr, 0) == pdPASS;
}

Result play(const char *name) {
  if (!tx || !requests) return Result::Unavailable;
  for (const Clip &clip : clips) {
    if (strcmp(name, clip.name) != 0) continue;
    const Clip *request = &clip;
    if (playing || xQueueSend(requests, &request, 0) != pdTRUE) return Result::Busy;
    return Result::Queued;
  }
  return Result::Unknown;
}
}
