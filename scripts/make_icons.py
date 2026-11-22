#!/usr/bin/env python3
"""Generate the PWA icons (needs Pillow): python scripts/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "icons"
BG, GOLD, SOFT = (8, 9, 12), (223, 181, 100), (18, 20, 28)
FONTS = ["C:/Windows/Fonts/georgiab.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
         "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"]


def font(size):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def master(size=1024, safe=1.0):
    """A dark tile with a gold card silhouette and 'DM'. `safe` < 1 shrinks the art (maskable)."""
    im = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(im)
    s = size * safe
    cx = cy = size / 2
    w, h = s * 0.50, s * 0.70
    box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    d.rounded_rectangle(box, radius=s * 0.045, fill=SOFT, outline=GOLD, width=max(4, int(s * 0.018)))
    inner = s * 0.035
    d.rounded_rectangle((box[0] + inner, box[1] + inner, box[2] - inner, box[3] - inner),
                        radius=s * 0.025, outline=(120, 98, 55), width=max(2, int(s * 0.006)))
    f = font(int(s * 0.27))
    d.text((cx, cy), "DM", font=f, fill=GOLD, anchor="mm")
    return im


def main():
    OUT.mkdir(exist_ok=True)
    m = master()
    for name, size in (("icon-180.png", 180), ("icon-192.png", 192), ("icon-512.png", 512), ("favicon.png", 64)):
        m.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    master(1024, 0.78).resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
