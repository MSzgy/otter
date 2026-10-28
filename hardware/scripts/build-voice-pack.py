"""Pack the otter's 21 voice lines into one blob for the ESP32's data partition.

Reads assets/pixel_game/voice/manifest.json and pcm/<id>.pcm (16 kHz, mono,
signed 16-bit little-endian), checks each clip's SHA-256 and format, and writes:

  header  "OTVO", u16 version=1, u16 count, u32 sample_rate, u32 reserved
  entries count x {char name[24], u32 offset, u32 bytes}   (offsets from the blob start)
  data    the PCM clips back to back

All integers little-endian. The blob lives 2 MiB into the ffat partition, after the
pixel animation pack: write it to 0x610000 + 0x200000 = 0x810000.

usage: python3 build-voice-pack.py <voice dir> <output .bin>
"""

import hashlib
import json
import struct
import sys
from pathlib import Path

MAGIC, VERSION, NAME_BYTES, SAMPLE_RATE = b"OTVO", 1, 24, 16000
ROOM = 0x100000  # the evolution bank starts 3 MiB in (build-evolution-pack.py)
HEADER = struct.Struct("<4sHHII")
ENTRY = struct.Struct(f"<{NAME_BYTES}sII")


def main():
    voice = Path(sys.argv[1])
    clips = json.loads((voice / "manifest.json").read_text())["clips"]
    data_start = HEADER.size + ENTRY.size * len(clips)
    entries, data = [], bytearray()
    for clip in clips:
        name = clip["id"]
        pcm = (voice / "pcm" / f"{name}.pcm").read_bytes()
        if hashlib.sha256(pcm).hexdigest() != clip["pcm_sha256"]:
            sys.exit(f"{name}: SHA-256 differs from manifest")
        if clip["sample_rate"] != SAMPLE_RATE or clip["channels"] != 1 or len(pcm) % 2:
            sys.exit(f"{name}: expected {SAMPLE_RATE} Hz mono 16-bit PCM")
        if len(name.encode()) >= NAME_BYTES:
            sys.exit(f"{name}: name too long")
        entries.append(ENTRY.pack(name.encode(), data_start + len(data), len(pcm)))
        data += pcm
    blob = HEADER.pack(MAGIC, VERSION, len(entries), SAMPLE_RATE, 0) + b"".join(entries) + data
    if len(blob) > ROOM:
        sys.exit(f"{len(blob)} bytes would overwrite the evolution bank")
    Path(sys.argv[2]).write_bytes(blob)
    seconds = len(data) / 2 / SAMPLE_RATE
    print(f"{len(entries)} clips verified, {seconds:.1f} s of audio, {len(blob)} bytes")


if __name__ == "__main__":
    main()
