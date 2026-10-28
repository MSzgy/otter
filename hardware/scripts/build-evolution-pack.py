"""Pack the evolved forms' device animations into a second animation bank.

Reads assets/evolution/manifest.json and its *.565.gz frames, checks every
decompressed frame against the manifest's raw SHA-256, recompresses it as a zlib
stream (the ROM inflater verifies its Adler-32), and writes OTSK version 2, which
allows long clips, play-once clips and clips that reuse another clip's frames:

  header  "OTSK", u16 version=2, u16 clips, u16 width, u16 height, u16 frames,
          u16 reserved
  clips   clips x {char name[24], u8 frames, u8 flags (1 = play once), u16 first}
  frames  frames x {u32 offset, u32 size, u16 delay_ms, u16 reserved}
          (offsets from the blob start; a clip uses frames[first .. first+frames))
  data    zlib streams of RGB565 frames, high byte first, rows top to bottom

All integers little-endian. Clips: the eight four-frame clips, from_<form> as
to_<form> backwards (no second copy), and to_<form>_cinematic, the 20-frame
version of the transition. Flash to 3 MiB into the ffat partition (0x910000),
after the first bank and the voice pack.

usage: python3 build-evolution-pack.py <evolution assets dir> <output .bin>
"""

import gzip
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

MAGIC, VERSION, NAME_BYTES, MAX_FRAMES = b"OTSK", 2, 24, 32
ONCE = 1
PARTITION_BYTES, BANK_OFFSET = 0x9E0000, 0x300000
HEADER = struct.Struct("<4sHHHHHH")
CLIP = struct.Struct(f"<{NAME_BYTES}sBBH")
FRAME = struct.Struct("<IIHH")


def main():
    root = Path(sys.argv[1])
    manifest = json.loads((root / "manifest.json").read_text())
    width, height = manifest["width"], manifest["height"]
    raw_size = width * height * 2

    stored = {}  # file -> (frame payload, delay) so a clip can reuse another's frames
    clips = []  # (name, flags, [(gzip path, delay_ms), ...])
    for clip in manifest["clips"].values():
        if "reverse_of" in clip:
            continue
        frames = [(f["gzip"], f["delay_ms"], f["raw_sha256"]) for f in clip["frames"]]
        clips.append((clip["id"], 0 if clip["loop"] else ONCE, frames))
    by_name = {name: frames for name, _, frames in clips}
    for clip in manifest["clips"].values():
        if "reverse_of" in clip:
            source = by_name[clip["reverse_of"]]
            delays = clip["delay_ms"]
            if len(delays) != len(source):
                sys.exit(f"{clip['id']}: frame count differs from {clip['reverse_of']}")
            backwards = zip(reversed(source), delays)  # noqa: B905 (system python3 is 3.9)
            frames = [(path, delay, sha) for (path, _, sha), delay in backwards]
            clips.append((clip["id"], ONCE, frames))
    for form, cinematic in manifest["cinematic"]["forms"].items():
        frames = [(f["gzip"], f["delay_ms"], f["raw_sha256"]) for f in cinematic["device_frames"]]
        clips.append((f"to_{form}_cinematic", ONCE, frames))

    frame_count = sum(len(frames) for _, _, frames in clips)
    data_start = HEADER.size + CLIP.size * len(clips) + FRAME.size * frame_count
    clip_records, frame_records, data = [], [], bytearray()
    for name, flags, frames in clips:
        if len(name.encode()) >= NAME_BYTES or not 1 <= len(frames) <= MAX_FRAMES:
            sys.exit(f"{name}: unsupported name or frame count")
        clip_records.append(CLIP.pack(name.encode(), len(frames), flags, len(frame_records)))
        for path, delay, sha in frames:
            if path not in stored:
                raw = gzip.decompress((root / path).read_bytes())
                if len(raw) != raw_size or hashlib.sha256(raw).hexdigest() != sha:
                    sys.exit(f"{path}: size or SHA-256 differs from manifest")
                packed = zlib.compress(raw, 9)
                stored[path] = (data_start + len(data), len(packed))
                data += packed
            offset, size = stored[path]
            frame_records.append(FRAME.pack(offset, size, delay, 0))

    header = HEADER.pack(MAGIC, VERSION, len(clips), width, height, frame_count, 0)
    blob = header + b"".join(clip_records) + b"".join(frame_records) + data
    if BANK_OFFSET + len(blob) > PARTITION_BYTES:
        sys.exit(f"{len(blob)} bytes do not fit after {BANK_OFFSET:#x}")
    Path(sys.argv[2]).write_bytes(blob)
    print(f"{len(clips)} clips, {frame_count} frames ({len(stored)} stored, verified),", end=" ")
    print(f"{len(blob)} bytes")


if __name__ == "__main__":
    main()
