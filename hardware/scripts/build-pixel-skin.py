"""Pack the D pixel otter animations into one blob for the ESP32's data partition.

Reads the style pack's manifest.json and device-animation/*.565.gz frames, checks
every decompressed frame against the manifest's raw SHA-256, recompresses it as a
zlib stream (the ROM inflater verifies its Adler-32), and writes:

  header  "OTSK", u16 version=1, u16 count, u16 width, u16 height, u32 reserved
  entries count x {char name[24], u8 frames, u8 pad[3], u16 delay_ms[4],
                   u32 offset[4], u32 size[4]}   (offsets from the blob start)
  data    zlib streams of RGB565 frames, high byte first, rows top to bottom

All integers little-endian. Flash the result to the ffat partition (0x610000).

usage: python3 build-pixel-skin.py <pixel-companion dir> <output .bin>
"""

import gzip
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

MAGIC, VERSION, MAX_FRAMES, NAME_BYTES = b"OTSK", 1, 4, 24
VOICE_OFFSET = 0x200000  # the voice pack starts 2 MiB into the partition (build-voice-pack.py)
ENTRY = struct.Struct(f"<{NAME_BYTES}sB3x{MAX_FRAMES}H{MAX_FRAMES}I{MAX_FRAMES}I")
HEADER = struct.Struct("<4sHHHHI")


def main():
    pack = Path(sys.argv[1])
    manifest = json.loads((pack / "manifest.json").read_text())
    width, height = manifest["width"], manifest["height"]
    raw_size = width * height * 2
    expressions = manifest["expressions"]
    data_start = HEADER.size + ENTRY.size * len(expressions)
    entries, data = [], bytearray()
    for expression in expressions:
        name, animation = expression["id"], expression["animation"]
        frames = animation["frames"]
        if len(name.encode()) >= NAME_BYTES or not 1 <= len(frames) <= MAX_FRAMES:
            sys.exit(f"{name}: unsupported name or frame count")
        delays, offsets, sizes = [], [], []
        for frame in frames:
            raw = gzip.decompress((pack / frame["rgb565_gzip"]).read_bytes())
            if len(raw) != raw_size or hashlib.sha256(raw).hexdigest() != frame["raw_sha256"]:
                sys.exit(f"{name} frame {frame['index']}: size or SHA-256 differs from manifest")
            packed = zlib.compress(raw, 9)
            delays.append(frame["delay_ms"])
            offsets.append(data_start + len(data))
            sizes.append(len(packed))
            data += packed
        pad = MAX_FRAMES - len(frames)
        entries.append(
            ENTRY.pack(name.encode(), len(frames), *delays, *[0] * pad, *offsets, *[0] * pad,
                       *sizes, *[0] * pad)
        )
    blob = HEADER.pack(MAGIC, VERSION, len(entries), width, height, 0) + b"".join(entries) + data
    if len(blob) > VOICE_OFFSET:
        sys.exit(f"{len(blob)} bytes would overwrite the voice pack at {VOICE_OFFSET:#x}")
    Path(sys.argv[2]).write_bytes(blob)
    frames_total = sum(len(e["animation"]["frames"]) for e in expressions)
    print(f"{len(entries)} expressions, {frames_total} frames verified, {len(blob)} bytes")


if __name__ == "__main__":
    main()
