#!/usr/bin/env python3
"""Download each card's main image once and store two WebP sizes (needs Pillow).

  images/t/<id>.webp   thumbnail (grid)      220 px wide
  images/l/<id>.webp   large (card view)     600 px wide
  data/images.json     ids that have local copies (the site prefers them over the wiki CDN)

NOTE: at the time of writing the Fandom CDN (static.wikia.nocookie.net) answers HTTP 403
to non-browser clients. This script identifies itself honestly and does NOT try to get
around that: on the first 403 it stops and leaves everything as it was, so the site
keeps using the CDN links. Run it only when the images may be fetched (e.g. with
permission from the rights holders / wiki staff, or from files you already have).

Usage: python scripts/fetch_images.py [--limit N] [--pause 0.5]
"""
import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "VetrinaDM/1.0 (non-commercial fan project; image archiver)"
SIZES = {"t": (220, 58), "l": (600, 62)}   # folder -> (width, WebP quality)


def encode(raw, width, quality):
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    h = round(im.height * width / im.width)
    out = io.BytesIO()
    im.resize((width, h), Image.LANCZOS).save(out, "WEBP", quality=quality, method=6)
    return out.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--pause", type=float, default=0.5)
    args = ap.parse_args()

    index = json.loads((ROOT / "data" / "index.json").read_text(encoding="utf-8"))
    manifest_file = ROOT / "data" / "images.json"
    done = set(json.loads(manifest_file.read_text(encoding="utf-8"))) if manifest_file.exists() else set()
    for d in SIZES:
        (ROOT / "images" / d).mkdir(parents=True, exist_ok=True)

    todo = [c for c in index if c["im"] and c["id"] not in done]
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(todo)} images to download ({len(done)} already done)")

    for n, c in enumerate(todo, 1):
        try:
            req = urllib.request.Request(c["im"], headers={"User-Agent": USER_AGENT})
            raw = urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                print(f"HTTP {e.code}: the image host refuses this client. Stopping without a workaround.")
                break
            print(f"  skip {c['id']}: HTTP {e.code}")
            continue
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  skip {c['id']}: {e}")
            continue
        for d, (w, q) in SIZES.items():
            (ROOT / "images" / d / f"{c['id']}.webp").write_bytes(encode(raw, w, q))
        done.add(c["id"])
        if n % 200 == 0:
            manifest_file.write_text(json.dumps(sorted(done)), encoding="utf-8")
            print(f"  {n}/{len(todo)}", flush=True)
        time.sleep(args.pause)

    manifest_file.write_text(json.dumps(sorted(done)), encoding="utf-8")
    print(f"{len(done)} cards have local images")


if __name__ == "__main__":
    sys.exit(main())
