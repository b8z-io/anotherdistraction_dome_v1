#!/usr/bin/env python3
"""Typeset the quote cards into one texture for the dome.

Reads params.json -> quote.cards (lists of rows) and quote.credit, renders
each card centred in EB Garamond, and writes:
  assets/text/quote.png   R = glyphs, G = soft halo (darkens what's behind
                          the words so they stay legible over the lattice)
  assets/text/quote.json  each card's rectangle in the texture, in pixels

render.py and the playground both use these, so the words look the same in
both. Re-run after changing the quote's text:  python tools/make_quote.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "assets" / "fonts" / "EBGaramond.ttf"
PX = 96            # font size in the texture
ROW = int(PX * 1.32)
PAD = 40           # room for the halo
W = 2048


def font(px, weight):
    f = ImageFont.truetype(str(FONT), px)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def main():
    P = json.loads((ROOT / "params.json").read_text())
    Q = P["quote"]
    weight = Q.get("font_weight", 500)
    blocks = [(c["rows"], PX) for c in Q["cards"]] + [([Q["credit"]], int(PX * 0.62))]
    heights = [len(rows) * int(px * 1.32) + 2 * PAD for rows, px in blocks]
    H = (sum(heights) + 3) // 4 * 4
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    rects, y = [], 0
    for (rows, px), h in zip(blocks, heights):
        f = font(px, weight)
        widths = [d.textlength(r, font=f) for r in rows]
        wmax = int(max(widths)) + 2 * PAD
        x0 = (W - wmax) // 2
        for k, (r, rw) in enumerate(zip(rows, widths)):
            d.text((x0 + PAD + (wmax - 2 * PAD - rw) / 2, y + PAD + k * int(px * 1.32)), r, font=f, fill=255)
        rects.append([x0, y, wmax, h])
        y += h
    halo = img.filter(ImageFilter.GaussianBlur(14)).point(lambda v: min(255, v * 3))
    rgba = Image.merge("RGBA", (img, halo, Image.new("L", (W, H), 0), Image.new("L", (W, H), 255)))
    out = ROOT / "assets" / "text"
    out.mkdir(parents=True, exist_ok=True)
    rgba.save(out / "quote.png", optimize=True)
    (out / "quote.json").write_text(json.dumps({"size": [W, H], "px": PX, "cards": rects[:-1], "credit": rects[-1]}, indent=1))
    print(f"{out / 'quote.png'}  {W}x{H}, {len(rects) - 1} cards + credit")


if __name__ == "__main__":
    main()
