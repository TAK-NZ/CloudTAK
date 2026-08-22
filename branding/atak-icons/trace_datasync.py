#!/usr/bin/env python3
"""
Trace a two-arrow "data sync" raster into a black-and-white SVG.

Handles two source conventions, detected automatically:

  alpha mode  glyph on a transparent field (ATAK's drawable PNGs)
  white mode  glyph on an opaque white field (the JPEG thumbnail)

Pipeline:
  1. Build a continuous 0..1 coverage map (alpha channel, or normalised
     distance from white). Coverage is kept continuous on purpose: the edge
     antialiasing carries sub-pixel shape information, and binarising early
     discards it. That costs little on a 240px source but wrecks a 48px one,
     where the staircase becomes the dominant feature.
  2. Crop to the glyph bounding box, pad to square.
  3. Resample the continuous map up to a fixed working resolution, so small and
     large sources are traced on comparable footing.
  4. Mild blur to regularise the contour, then threshold once, at the end.
     Soft-edged sources otherwise produce a jagged boundary and potrace answers
     with hundreds of tiny segments.
  5. potrace, then re-normalise into a 24x24 viewBox with an optical margin to
     match the Tabler grid the rest of the nav bar uses.
  6. Emit one monochrome path with fill="currentColor".

Usage: trace_datasync.py <input-raster> <output.svg>
"""
import sys
import pathlib
import numpy as np
from PIL import Image, ImageFilter
import potrace

SRC = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])

WHITE_DIST = 25.0   # RMS distance from white counted as full coverage, white mode
CUT = 0.5           # coverage threshold, applied once at the end
WORK_SIDE = 660     # working trace resolution
SMOOTH_REL = 0.005  # blur radius as a fraction of the working resolution
VIEWBOX = 24.0      # Tabler icons are drawn on a 24x24 grid
MARGIN = 1.0        # blank units per side inside the viewBox
PREC = 2            # coordinate decimal places


def build_coverage(path: pathlib.Path) -> np.ndarray:
    """Return a continuous 0..1 glyph coverage map."""
    im = Image.open(path).convert("RGBA")
    arr = np.asarray(im).astype(np.float64)
    alpha = arr[..., 3]
    transparent_share = (alpha < 40).mean()

    if transparent_share > 0.15:
        mode = "alpha"
        cov = alpha / 255.0
    else:
        mode = "white"
        dist = np.sqrt(((255.0 - arr[..., :3]) ** 2).mean(axis=2))
        cov = np.clip(dist / WHITE_DIST, 0.0, 1.0)

    print(f"keying mode         : {mode} "
          f"({transparent_share * 100:.1f}% of source transparent)")

    solid = cov > CUT
    if not solid.any():
        raise SystemExit(f"error: no glyph found in {path} under {mode} keying")
    if solid.mean() > 0.90:
        raise SystemExit(
            f"error: {path} is {solid.mean() * 100:.0f}% foreground under {mode} "
            f"keying; this looks like a background plate, not an icon"
        )
    print(f"glyph coverage      : {solid.mean() * 100:.2f}% of source pixels")
    return cov


def crop_to_glyph(cov: np.ndarray) -> np.ndarray:
    """Crop to the glyph bbox, then pad to square so aspect ratio survives."""
    solid = cov > CUT
    rows = np.where(np.any(solid, axis=1))[0]
    cols = np.where(np.any(solid, axis=0))[0]
    y0, y1 = rows[0], rows[-1]
    x0, x1 = cols[0], cols[-1]
    cropped = cov[y0:y1 + 1, x0:x1 + 1]

    h, w = cropped.shape
    side = max(h, w)
    square = np.zeros((side, side), dtype=cov.dtype)
    square[(side - h) // 2:(side - h) // 2 + h,
           (side - w) // 2:(side - w) // 2 + w] = cropped
    print(f"cropped to square   : {side}x{side}")
    return square


def resample_and_threshold(cov: np.ndarray) -> np.ndarray:
    """Resample the continuous map to the working size, smooth, then binarise."""
    img = Image.fromarray((np.clip(cov, 0, 1) * 255).astype(np.uint8), mode="L")
    img = img.resize((WORK_SIDE, WORK_SIDE), Image.LANCZOS)

    radius = SMOOTH_REL * WORK_SIDE
    img = img.filter(ImageFilter.GaussianBlur(radius=radius))
    print(f"traced at           : {WORK_SIDE}x{WORK_SIDE}, blur r={radius:.2f}")

    return np.asarray(img).astype(np.float64) / 255.0 > CUT


def to_svg(mask: np.ndarray) -> str:
    # potracer's Bitmap.__init__ calls invert() unconditionally, so hand it the
    # complement and it ends up tracing the glyph rather than the background.
    path = potrace.Bitmap(~mask).trace(
        turdsize=6,                     # drop speckles
        alphamax=1.0,                   # corner smoothing
        opticurve=True, opttolerance=0.4,
    )

    side = mask.shape[0]
    scale = (VIEWBOX - 2 * MARGIN) / side

    def n(v: float) -> str:
        t = f"{v:.{PREC}f}".rstrip("0").rstrip(".")
        if t in ("", "-0"):
            t = "0"
        return t[1:] if t.startswith("0.") else t

    def pt(p) -> str:
        return f"{n(p.x * scale + MARGIN)},{n(p.y * scale + MARGIN)}"

    d = []
    for curve in path:
        d.append(f"M{pt(curve.start_point)}")
        for seg in curve:
            if seg.is_corner:
                d.append(f"L{pt(seg.c)}L{pt(seg.end_point)}")
            else:
                d.append(f"C{pt(seg.c1)} {pt(seg.c2)} {pt(seg.end_point)}")
        d.append("Z")

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        'width="24" height="24" fill="currentColor" stroke="none" '
        'aria-hidden="true">\n'
        f'  <path fill-rule="evenodd" d="{"".join(d)}"/>\n'
        '</svg>\n'
    )


svg = to_svg(resample_and_threshold(crop_to_glyph(build_coverage(SRC))))
OUT.write_text(svg)
print(f"wrote               : {OUT}  ({len(svg)} bytes)")
