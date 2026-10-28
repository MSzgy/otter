#include "pixel_skin.h"
#include "display.h"
#include <cstring>
#include <esp_heap_caps.h>
#include <esp_partition.h>
#include <miniz.h>  // ROM inflater: tinfl_decompress lives in the ESP32-S3 ROM

namespace skin {
namespace {
constexpr char magic[4] = {'O', 'T', 'S', 'K'};
constexpr size_t nameBytes = 24, firstBankFrames = 4, maxClips = 48, maxFrames = 256, bufferCount = 4;
constexpr uint32_t evolutionOffset = 0x300000;  // after the first bank (2 MiB) and the voice pack
constexpr size_t frameBytes = size_t(screen::width) * screen::height * 2;
constexpr uint32_t maxPackedBytes = frameBytes + 1024;  // zlib never grows data by much

// First bank, OTSK version 1 (build-pixel-skin.py).
struct __attribute__((packed)) HeaderV1 {
  char magic[4];
  uint16_t version, count, width, height;
  uint32_t reserved;
};
struct __attribute__((packed)) EntryV1 {
  char name[nameBytes];
  uint8_t frames, pad[3];
  uint16_t delayMs[firstBankFrames];
  uint32_t offset[firstBankFrames], size[firstBankFrames];
};
// Second bank, OTSK version 2 (build-evolution-pack.py).
struct __attribute__((packed)) HeaderV2 {
  char magic[4];
  uint16_t version, clips, width, height, frames, reserved;
};
struct __attribute__((packed)) ClipV2 {
  char name[nameBytes];
  uint8_t frames, flags;  // flags bit 0: play once
  uint16_t first;
};
struct __attribute__((packed)) FrameV2 {
  uint32_t offset, size;
  uint16_t delayMs, reserved;
};
static_assert(sizeof(HeaderV1) == 16 && sizeof(EntryV1) == 68, "must match build-pixel-skin.py");
static_assert(sizeof(HeaderV2) == 16 && sizeof(ClipV2) == 28 && sizeof(FrameV2) == 12,
              "must match build-evolution-pack.py");

// Both banks end up here: offsets from the partition start.
struct Frame {
  uint32_t offset, size;
  uint16_t delayMs;
};
struct Clip {
  char name[nameBytes];
  uint16_t first;
  uint8_t frames;
  bool once;
};

const esp_partition_t *pack = nullptr;
Clip clips[maxClips];
Frame frameTable[maxFrames];
size_t clipCount = 0, frameCount = 0, firstBankClips = 0;
uint16_t *buffer[bufferCount] = {};
int bufferFrame[bufferCount] = {-1, -1, -1, -1};  // frameTable index each buffer holds
uint8_t *packed = nullptr;
tinfl_decompressor *inflater = nullptr;
int loaded = -1;
uint32_t clipMs = 0, decodeMs = 0;

bool validName(const char *name) {
  return name[0] && memchr(name, '\0', nameBytes) != nullptr;
}
bool validFrame(uint32_t offset, uint32_t size, uint16_t delayMs) {
  return delayMs > 0 && size > 0 && size <= maxPackedBytes && offset + size <= pack->size &&
         offset + size > offset;
}
int findClip(const char *wanted) {
  for (size_t i = 0; i < clipCount; i++)
    if (strcmp(clips[i].name, wanted) == 0) return int(i);
  return -1;
}

// Any damaged entry rejects the whole bank, as before.
bool loadFirstBank() {
  HeaderV1 header;
  if (esp_partition_read(pack, 0, &header, sizeof(header)) != ESP_OK) return false;
  if (memcmp(header.magic, magic, sizeof(magic)) != 0 || header.version != 1 ||
      header.width != screen::width || header.height != screen::height || header.count == 0 ||
      header.count > maxClips)
    return false;
  for (size_t i = 0; i < header.count; i++) {
    EntryV1 e;
    if (esp_partition_read(pack, sizeof(header) + i * sizeof(e), &e, sizeof(e)) != ESP_OK ||
        !validName(e.name) || e.frames < 1 || e.frames > firstBankFrames || findClip(e.name) >= 0)
      return false;
    Clip &c = clips[clipCount];
    memcpy(c.name, e.name, nameBytes);
    c.first = uint16_t(frameCount);
    c.frames = e.frames;
    c.once = false;
    for (size_t f = 0; f < e.frames; f++) {
      if (!validFrame(e.offset[f], e.size[f], e.delayMs[f])) return false;
      frameTable[frameCount++] = {e.offset[f], e.size[f], e.delayMs[f]};
    }
    clipCount++;
  }
  return true;
}

// Optional: a missing or damaged second bank leaves the first one as it was.
void loadSecondBank() {
  HeaderV2 header;
  if (pack->size <= evolutionOffset + sizeof(header) ||
      esp_partition_read(pack, evolutionOffset, &header, sizeof(header)) != ESP_OK)
    return;
  if (memcmp(header.magic, magic, sizeof(magic)) != 0 || header.version != 2 ||
      header.width != screen::width || header.height != screen::height || header.clips == 0 ||
      header.frames == 0 || clipCount + header.clips > maxClips || frameCount + header.frames > maxFrames)
    return;
  const size_t clipsBefore = clipCount, framesBefore = frameCount;
  const uint32_t clipTable = evolutionOffset + sizeof(header);
  const uint32_t frameRecords = clipTable + header.clips * sizeof(ClipV2);
  bool ok = true;
  for (size_t i = 0; ok && i < header.frames; i++) {
    FrameV2 f;
    ok = esp_partition_read(pack, frameRecords + i * sizeof(f), &f, sizeof(f)) == ESP_OK &&
         validFrame(evolutionOffset + f.offset, f.size, f.delayMs);
    if (ok) frameTable[frameCount++] = {evolutionOffset + f.offset, f.size, f.delayMs};
  }
  for (size_t i = 0; ok && i < header.clips; i++) {
    ClipV2 c;
    ok = esp_partition_read(pack, clipTable + i * sizeof(c), &c, sizeof(c)) == ESP_OK &&
         validName(c.name) && c.frames >= 1 && size_t(c.first) + c.frames <= header.frames &&
         findClip(c.name) < 0;
    if (!ok) break;
    Clip &clip = clips[clipCount++];
    memcpy(clip.name, c.name, nameBytes);
    clip.first = uint16_t(framesBefore + c.first);
    clip.frames = c.frames;
    clip.once = c.flags & 1;
  }
  if (!ok) {
    clipCount = clipsBefore;
    frameCount = framesBefore;
  }
}

// Inflates one zlib stream; the Adler-32 check rejects damaged data.
bool decode(const Frame &f, uint16_t *out) {
  if (esp_partition_read(pack, f.offset, packed, f.size) != ESP_OK) return false;
  tinfl_init(inflater);
  size_t inSize = f.size, outSize = frameBytes;
  auto *bytes = reinterpret_cast<mz_uint8 *>(out);
  const tinfl_status status = tinfl_decompress(
    inflater, packed, &inSize, bytes, bytes, &outSize,
    TINFL_FLAG_PARSE_ZLIB_HEADER | TINFL_FLAG_COMPUTE_ADLER32 | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
  return status == TINFL_STATUS_DONE && outSize == frameBytes;
}
}

bool begin() {
  pack = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, nullptr);
  if (!pack || !loadFirstBank()) {
    clipCount = frameCount = 0;
    return false;
  }
  for (uint16_t *&b : buffer)
    b = static_cast<uint16_t *>(heap_caps_malloc(frameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  packed = static_cast<uint8_t *>(heap_caps_malloc(maxPackedBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  inflater = static_cast<tinfl_decompressor *>(malloc(sizeof(tinfl_decompressor)));
  bool allocated = packed && inflater;
  for (uint16_t *b : buffer) allocated = allocated && b;
  if (!allocated) {
    clipCount = frameCount = 0;
    return false;
  }
  firstBankClips = clipCount;
  loadSecondBank();
  return true;
}

bool available() {
  return clipCount > 0;
}

size_t count() {
  return clipCount;
}

size_t evolutionCount() {
  return clipCount - firstBankClips;
}

const char *name(int clip) {
  return clip >= 0 && size_t(clip) < clipCount ? clips[clip].name : "";
}

int find(const char *wanted) {
  return findClip(wanted);
}

bool select(int clip) {
  if (clip < 0 || size_t(clip) >= clipCount) return false;
  const Clip &c = clips[clip];
  clipMs = 0;
  for (size_t i = 0; i < c.frames; i++) clipMs += frameTable[c.first + i].delayMs;
  loaded = clip;
  if (pixels(0)) return true;
  loaded = -1;  // a damaged clip must not stay current
  return false;
}

uint32_t lastDecodeMs() {
  return decodeMs;
}

int frameAt(uint32_t elapsedMs) {
  if (loaded < 0) return -1;
  const Clip &c = clips[loaded];
  uint32_t t = c.once ? (elapsedMs < clipMs ? elapsedMs : clipMs - 1) : elapsedMs % clipMs;
  for (size_t i = 0; i < c.frames; i++) {
    const uint16_t delay = frameTable[c.first + i].delayMs;
    if (t < delay) return int(i);
    t -= delay;
  }
  return c.frames - 1;
}

const uint16_t *pixels(int index) {
  if (loaded < 0 || index < 0 || index >= clips[loaded].frames) return nullptr;
  const int f = clips[loaded].first + index;
  const size_t slot = size_t(index) % bufferCount;  // four-frame clips stay fully cached
  if (bufferFrame[slot] != f) {
    const uint32_t started = millis();
    bufferFrame[slot] = -1;
    if (!decode(frameTable[f], buffer[slot])) return nullptr;
    bufferFrame[slot] = f;
    decodeMs = millis() - started;
  }
  return buffer[slot];
}
}
