"""Make the desktop pet's transparent GIFs from the ESP32 otter's pixel frames.

The desktop otter should look like the physical one, so both use the same D /
pixel_game frames and timing (hardware/assets/pixel_game). The board's frames
sit on one flat background colour; here that colour becomes transparent, every
frame is cropped to the same box (so the otter does not jump between moods)
and each desktop Mood gets one looping GIF in desktop/src/assets/otter/.

Needs Pillow:  uv run --with pillow python desktop/scripts/build_pet_gifs.py
"""

import gzip
import json
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PACK = ROOT / "hardware/assets/pixel_game"
OUT = ROOT / "desktop/src/assets/otter"
# The desktop Mood type (desktop/src/Otter.tsx); the pack covers all of them.
MOODS = ["idle", "working", "happy", "offline", "sleeping", "eating", "playing",
         "dancing", "waving", "tickled", "waking", "held", "speaking"]
TRANSPARENT = 255  # palette index reserved for the background


def rgba(raw, width, height):
    pixels = [raw[i] << 8 | raw[i + 1] for i in range(0, len(raw), 2)]  # RGB565, high byte first
    background = Counter(pixels[:width]).most_common(1)[0][0]
    image = Image.new("RGBA", (width, height))
    image.putdata([
        (0, 0, 0, 0) if p == background
        else ((p >> 11) * 255 // 31, (p >> 5 & 63) * 255 // 63, (p & 31) * 255 // 31, 255)
        for p in pixels
    ])
    return image


def paletted(frame):
    # 255 colours plus one transparent index; no dithering, so pixel edges stay clean.
    image = frame.convert("RGB").quantize(colors=255, dither=Image.Dither.NONE)
    palette = image.getpalette()[: 255 * 3]
    image.putpalette(palette + [0] * (768 - len(palette)))
    hidden = frame.getchannel("A").point(lambda a: 255 if a < 128 else 0)
    image.paste(TRANSPARENT, mask=hidden)
    return image


def main():
    manifest = json.loads((PACK / "manifest.json").read_text())
    width, height = manifest["width"], manifest["height"]
    expressions = {e["id"]: e["animation"] for e in manifest["expressions"]}
    frames = {
        mood: [rgba(gzip.decompress((PACK / f["rgb565_gzip"]).read_bytes()), width, height)
               for f in expressions[mood]["frames"]]
        for mood in MOODS
    }
    boxes = [f.getbbox() for fs in frames.values() for f in fs]
    left, top = min(b[0] for b in boxes), min(b[1] for b in boxes)
    right, bottom = max(b[2] for b in boxes), max(b[3] for b in boxes)
    side = max(right - left, bottom - top)  # square, like the desktop canvas
    box = (left - (side - (right - left)) // 2, top - (side - (bottom - top)) // 2)
    OUT.mkdir(parents=True, exist_ok=True)
    for mood, images in frames.items():
        squared = []
        for image in images:
            canvas = Image.new("RGBA", (side, side))
            canvas.paste(image.crop((box[0], box[1], box[0] + side, box[1] + side)))
            squared.append(paletted(canvas))
        delays = [f["delay_ms"] for f in expressions[mood]["frames"]]
        squared[0].save(OUT / f"{mood}.gif", save_all=True, append_images=squared[1:],
                        duration=delays, loop=0, disposal=2, transparency=TRANSPARENT,
                        optimize=False)
    print(f"{len(frames)} GIFs, {side}x{side}, from {sum(map(len, frames.values()))} frames")


if __name__ == "__main__":
    main()
