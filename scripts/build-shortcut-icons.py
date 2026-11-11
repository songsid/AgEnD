#!/usr/bin/env python3
"""Build the desktop-shortcut icons from src/ui/icons/icon-512.png (Pillow).

  templates/icons/agend.ico          "AgEnD 儀表板"
  templates/icons/agend-restart.ico  "AgEnD 重新啟動": the same tile with a ↻ badge, so the two read apart

Each .ico holds PNG-compressed images at 16, 24, 32, 48, 64 and 256 px (Windows Vista+ reads PNG entries at every
size). The same entries are the Linux launchers' hicolor PNGs (src/linux-launchers.ts extracts them), so there is one
asset pair for both. Output is deterministic for a given input and Pillow version; the committed files are what ships,
and tests/shortcut-icons.test.ts checks their structure and that the Windows installer embeds exactly these bytes.

Run: python3 scripts/build-shortcut-icons.py   (then: node scripts/embed-shortcut-icons.mjs)
"""
import io, struct, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src/ui/icons/icon-512.png"
OUT = ROOT / "templates/icons"
SIZES = [16, 24, 32, 48, 64, 256]
NAVY = (20, 39, 61, 255)       # the "Ag" ink (#14273d)
WHITE = (255, 255, 255, 255)

def badge(size: int) -> Image.Image:
    """A navy disc with a white clockwise ↻ arrow and a white rim, drawn at 8x then reduced."""
    s = size * 8
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    rim = max(1, s // 14)
    d.ellipse((0, 0, s - 1, s - 1), fill=WHITE)
    d.ellipse((rim, rim, s - 1 - rim, s - 1 - rim), fill=NAVY)
    pad = s * 0.27
    box = (pad, pad, s - pad, s - pad)
    w = max(2, int(s * 0.11))
    d.arc(box, start=-60, end=230, fill=WHITE, width=w)
    # Arrowhead at the arc's END (230°, upper left), pointing on clockwise: the ↻ glyph. Pillow's angles run clockwise
    # (y down), so the point at angle a is (cos a, sin a) and the clockwise direction there is (-sin a, cos a).
    import math
    cx, cy, r = s / 2, s / 2, (s - 2 * pad) / 2
    a = math.radians(230)
    tip = (cx + r * math.cos(a), cy + r * math.sin(a))
    h = s * 0.19
    t = (-math.sin(a), math.cos(a))
    n = (math.cos(a), math.sin(a))
    p1 = (tip[0] + t[0] * h, tip[1] + t[1] * h)
    p2 = (tip[0] - n[0] * h * 0.7, tip[1] - n[1] * h * 0.7)
    p3 = (tip[0] + n[0] * h * 0.7, tip[1] + n[1] * h * 0.7)
    d.polygon([p1, p2, p3], fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)

def tile(base: Image.Image, size: int, restart: bool) -> Image.Image:
    im = base.resize((size, size), Image.LANCZOS)
    if restart:
        b = max(8, round(size * (0.5 if size < 48 else 0.42)))
        im.alpha_composite(badge(b), (size - b, size - b))
    return im

def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()

def ico(images: list) -> bytes:
    head = struct.pack("<HHH", 0, 1, len(images))
    entries, blobs, offset = b"", b"", 6 + 16 * len(images)
    for size, data in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return head + entries + blobs

def main() -> None:
    base = Image.open(SRC).convert("RGBA")
    OUT.mkdir(parents=True, exist_ok=True)
    for name, restart in (("agend.ico", False), ("agend-restart.ico", True)):
        data = ico([(s, png_bytes(tile(base, s, restart))) for s in SIZES])
        (OUT / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes")
    if len(sys.argv) > 1:   # a preview sheet of every size, for review (not committed)
        sheet = Image.new("RGBA", (sum(SIZES) + 10 * len(SIZES) + 10, 2 * 256 + 30), (245, 245, 245, 255))
        x = 10
        for s in SIZES:
            for row, restart in enumerate((False, True)):
                sheet.alpha_composite(tile(base, s, restart), (x, 10 + row * 266))
            x += s + 10
        sheet.save(sys.argv[1])

if __name__ == "__main__":
    main()
