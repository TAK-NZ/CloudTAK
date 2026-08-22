#!/usr/bin/env python3
"""
Outline-trace ATAK white-on-transparent line-art PNGs into SVG paths.

Approach: use the alpha channel as the bitmap (icons are pure white + alpha),
upsample 4x for smoother curves, potrace it, then emit a 24x24 viewBox SVG
using fill="currentColor" so it themes like a Tabler icon.
"""
import sys, pathlib
from PIL import Image
import numpy as np
import potrace

SRC = pathlib.Path(sys.argv[1])
DST = pathlib.Path(sys.argv[2])
DST.mkdir(parents=True, exist_ok=True)

UPSAMPLE = 2          # trace at 384x384; 4x gains nothing visible but doubles size
VIEWBOX = 24.0        # Tabler icons use a 24x24 grid
PREC = 2              # coordinate decimal places


def trace(png: pathlib.Path) -> str:
    im = Image.open(png).convert("RGBA")
    w, h = im.size
    im = im.resize((w * UPSAMPLE, h * UPSAMPLE), Image.LANCZOS)
    alpha = np.array(im.split()[-1])
    # potracer's Bitmap.__init__ calls invert() unconditionally, so hand it the
    # complement of the glyph and it ends up tracing the glyph itself.
    bitmap = potrace.Bitmap(alpha <= 128)

    path = bitmap.trace(
        turdsize=4,                                 # drop specks
        alphamax=1.0,                               # corner smoothing
        opticurve=True, opttolerance=0.6,           # aggressive curve merging
    )

    scale = VIEWBOX / (w * UPSAMPLE)

    def n(v):
        # trim trailing zeros and the leading zero of "0.xx"
        t = f"{v:.{PREC}f}".rstrip("0").rstrip(".")
        if t in ("", "-0"):
            t = "0"
        return t[1:] if t.startswith("0.") else t

    def pt(p):
        return f"{n(p.x * scale)},{n(p.y * scale)}"

    d = []
    for curve in path:
        d.append(f"M{pt(curve.start_point)}")
        for seg in curve:
            if seg.is_corner:
                d.append(f"L{pt(seg.c)}L{pt(seg.end_point)}")
            else:
                d.append(f"C{pt(seg.c1)} {pt(seg.c2)} {pt(seg.end_point)}")
        d.append("Z")
    dattr = "".join(d)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        f'width="24" height="24" fill="currentColor" '
        f'stroke="none" aria-hidden="true">\n'
        f'  <path fill-rule="evenodd" d="{dattr}"/>\n'
        f'</svg>\n'
    )


count = 0
for png in sorted(SRC.glob("*.png")):
    svg = trace(png)
    out = DST / (png.stem + ".svg")
    out.write_text(svg)
    print(f"{png.name:46s} -> {out.name:46s} {len(svg):6d} bytes")
    count += 1
print(f"\n{count} icons traced")
