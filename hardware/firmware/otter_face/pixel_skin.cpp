#include "pixel_skin.h"
#include "display.h"
#include <cstring>
#include <esp_heap_caps.h>
#include <esp_partition.h>
#include <miniz.h>  // ROM inflater: tinfl_decompress lives in the ESP32-S3 ROM

namespace skin {
namespace {
constexpr char magic[4] = {'O', 'T', 'S', 'K'};
constexpr uint16_t version = 1;
constexpr size_t maxFrames = 4, maxExpressions = 32, nameBytes = 24;
constexpr size_t frameBytes = size_t(screen::width) * screen::height * 2;
constexpr uint32_t maxPackedBytes = frameBytes + 1024;  // zlib never grows data by much

struct __attribute__((packed)) Header {
  char magic[4];
  uint16_t version, count, width, height;
  uint32_t reserved;
};
struct __attribute__((packed)) Entry {
  char name[nameBytes];
  uint8_t frames, pad[3];
  uint16_t delayMs[maxFrames];
  uint32_t offset[maxFrames], size[maxFrames];
};
static_assert(sizeof(Header) == 16 && sizeof(Entry) == 68, "must match build-pixel-skin.py");

const esp_partition_t *pack = nullptr;
Entry entries[maxExpressions];
size_t entryCount = 0;
uint16_t *frames[maxFrames] = {};
uint8_t *packed = nullptr;
tinfl_decompressor *inflater = nullptr;
int loaded = -1;
uint32_t loopMs = 0, decodeMs = 0;

bool valid(const Entry &e) {
  if (!e.name[0] || memchr(e.name, '\0', nameBytes) == nullptr) return false;
  if (e.frames < 1 || e.frames > maxFrames) return false;
  for (size_t i = 0; i < e.frames; i++) {
    if (e.delayMs[i] == 0 || e.size[i] == 0 || e.size[i] > maxPackedBytes) return false;
    if (e.offset[i] + e.size[i] > pack->size || e.offset[i] + e.size[i] < e.offset[i]) return false;
  }
  return true;
}

// Inflates one zlib stream; the Adler-32 check rejects damaged data.
bool decode(const Entry &e, size_t i, uint16_t *out) {
  if (esp_partition_read(pack, e.offset[i], packed, e.size[i]) != ESP_OK) return false;
  tinfl_init(inflater);
  size_t inSize = e.size[i], outSize = frameBytes;
  auto *bytes = reinterpret_cast<mz_uint8 *>(out);
  const tinfl_status status = tinfl_decompress(
    inflater, packed, &inSize, bytes, bytes, &outSize,
    TINFL_FLAG_PARSE_ZLIB_HEADER | TINFL_FLAG_COMPUTE_ADLER32 | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
  return status == TINFL_STATUS_DONE && outSize == frameBytes;
}
}

bool begin() {
  pack = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, nullptr);
  Header header;
  if (!pack || esp_partition_read(pack, 0, &header, sizeof(header)) != ESP_OK) return false;
  if (memcmp(header.magic, magic, sizeof(magic)) != 0 || header.version != version ||
      header.width != screen::width || header.height != screen::height || header.count == 0 ||
      header.count > maxExpressions)
    return false;
  if (esp_partition_read(pack, sizeof(header), entries, header.count * sizeof(Entry)) != ESP_OK)
    return false;
  for (size_t i = 0; i < header.count; i++)
    if (!valid(entries[i])) return false;

  for (uint16_t *&f : frames)
    f = static_cast<uint16_t *>(heap_caps_malloc(frameBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  packed = static_cast<uint8_t *>(heap_caps_malloc(maxPackedBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  inflater = static_cast<tinfl_decompressor *>(malloc(sizeof(tinfl_decompressor)));
  for (uint16_t *f : frames)
    if (!f) return false;
  if (!packed || !inflater) return false;
  entryCount = header.count;
  return true;
}

bool available() {
  return entryCount > 0;
}

size_t count() {
  return entryCount;
}

const char *name(int expression) {
  return expression >= 0 && size_t(expression) < entryCount ? entries[expression].name : "";
}

int find(const char *wanted) {
  for (size_t i = 0; i < entryCount; i++)
    if (strcmp(entries[i].name, wanted) == 0) return int(i);
  return -1;
}

bool select(int expression) {
  if (expression == loaded) return true;
  if (expression < 0 || size_t(expression) >= entryCount) return false;
  const uint32_t started = millis();
  const Entry &e = entries[expression];
  loaded = -1;  // a failure part-way must not leave a half-decoded expression on screen
  for (size_t i = 0; i < e.frames; i++)
    if (!decode(e, i, frames[i])) return false;
  loopMs = 0;
  for (size_t i = 0; i < e.frames; i++) loopMs += e.delayMs[i];
  loaded = expression;
  decodeMs = millis() - started;
  return true;
}

uint32_t lastDecodeMs() {
  return decodeMs;
}

const uint16_t *frame(uint32_t elapsedMs) {
  if (loaded < 0) return nullptr;
  const Entry &e = entries[loaded];
  uint32_t t = elapsedMs % loopMs;
  for (size_t i = 0; i < e.frames; i++) {
    if (t < e.delayMs[i]) return frames[i];
    t -= e.delayMs[i];
  }
  return frames[e.frames - 1];
}
}
