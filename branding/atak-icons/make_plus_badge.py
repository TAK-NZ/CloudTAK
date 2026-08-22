#!/usr/bin/env python3
"""
Add ATAK's "+" create badge to a base icon, producing a derived SVG.

Several ATAK shape tools (polygon, rectangle, circle) carry a `+` in the lower
right meaning "create a new one". CloudTAK has draw tools with no ATAK
equivalent, or whose ATAK icon lacks the badge. This composes the badge onto a
base icon so those entries join the same visual convention.

The badge is not redrawn -- both bars are lifted verbatim from an already
converted ATAK icon (rectangle.svg by default), so every badge in the set is
byte-identical.

Two base kinds are handled:

  stroke-based (Tabler)   root carries stroke="currentColor" and a stroke-width.
                          Pass --stroke-width to bake the weight; see below.
  fill-based (ATAK)       already fill="currentColor"; content is copied as-is.

Notching
--------
ATAK does not sit the badge *beside* the shape, it cuts a hole in the shape so
the badge sits inside it. Pass --notch to reproduce that with an SVG `mask`.
Masks are luminance-based rather than colour-based, so this stays correct on both
light and dark themes.

Only notch when the base actually collides with the badge. Measured ink inside
the badge disc, at the weights used here:

    Tabler cone     3075 px  -> needs it
    Tabler line        0 px  -> does not
    ATAK ic_point      0 px  -> does not

Notching a base that does not collide just erases part of it for no reason.

Stroke weight
-------------
For stroke-based bases the weight is baked in, because these icons ignore the
`stroke` prop (the ATAK ones are fills and cannot honour it). Match ATAK's
apparent weight rather than its nominal one -- round caps and antialiasing make
rendered thickness heavier than `stroke-width` suggests. Measured in 24-space:

    ATAK rectangle          1.20        stroke-width 1.0  -> 1.14
    ATAK ic_menu_circle     1.26        stroke-width 1.1  -> 1.26  <- matches
    ATAK polygon            1.44        stroke-width 1.2  -> 1.38

So --stroke-width 1.1 is the value that blends.

Usage:
  make_plus_badge.py <base.svg> <out.svg> [--stroke-width W] [--notch]
                     [--badge-source rectangle.svg]
"""
import argparse
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent

# Badge geometry, measured from the rendered badge in 24-space. The disc is only
# used for --notch; it is sized to clear the bars with a little margin.
BADGE_CX, BADGE_CY, BADGE_R = 19.56, 18.84, 4.3
BADGE_SCALE = 0.8          # the scale the converter applies to 30x30 drawables
MASK_ID = "taknz-plus-notch"


def badge_paths(src: pathlib.Path) -> tuple[str, str]:
    """Lift the two `+` bar paths from an already-converted ATAK icon."""
    text = src.read_text()
    ds = re.findall(r'<path[^>]*\sd="([^"]*)"', text)
    if len(ds) < 2:
        raise SystemExit(f"error: {src} has {len(ds)} paths, expected the two "
                         f"badge bars first")
    # In every ATAK shape drawable the badge bars are the first two paths and the
    # shape itself is last. Guard against that assumption silently changing.
    for d in ds[:2]:
        if not d.startswith(("M24.5", "M27.5")):
            raise SystemExit(
                f"error: {src.name} path order changed -- expected the badge "
                f"bars first, got {d[:12]!r}. Re-check before trusting output."
            )
    return ds[0], ds[1]


def base_content(src: pathlib.Path) -> tuple[str, bool]:
    """
    Return the drawable content of a base icon, and whether it is stroke-based.

    Tabler icons include a transparent full-box path as a hit target; it paints
    nothing and is dropped.
    """
    text = src.read_text()
    root = re.search(r"<svg\b[^>]*>", text, re.S)
    if not root:
        raise SystemExit(f"error: {src} has no <svg> root")
    stroked = 'stroke="currentColor"' in root.group(0)

    inner = text[root.end():text.rindex("</svg>")]
    kept = []
    for el in re.findall(r"<(?:path|g|circle|rect|ellipse|polyline|polygon)\b[^>]*?/?>"
                         r"|</g>", inner, re.S):
        if 'fill="none"' in el and 'stroke="none"' in el:
            continue                      # Tabler's invisible hit-target path
        kept.append(el.strip())
    if not kept:
        raise SystemExit(f"error: {src} yielded no drawable content")
    return "\n".join("    " + k for k in kept), stroked


ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("out")
ap.add_argument("--stroke-width", type=float, default=None,
                help="bake this stroke-width (stroke-based bases only)")
ap.add_argument("--notch", action="store_true",
                help="cut a hole in the base where the badge sits")
ap.add_argument("--badge-source", default=str(HERE / "drawtools" / "rectangle.svg"))
a = ap.parse_args()

pv, ph = badge_paths(pathlib.Path(a.badge_source))
content, stroked = base_content(pathlib.Path(a.base))

if stroked and a.stroke_width is None:
    sys.exit("error: base is stroke-based; pass --stroke-width "
             "(1.1 matches ATAK's apparent weight)")
if not stroked and a.stroke_width is not None:
    sys.exit("error: base is fill-based; --stroke-width would have no effect")

open_g, close_g = "", ""
if stroked:
    open_g = (f'  <g fill="none" stroke="currentColor" '
              f'stroke-width="{a.stroke_width:g}" stroke-linecap="round" '
              f'stroke-linejoin="round"')
    open_g += f' mask="url(#{MASK_ID})">' if a.notch else ">"
    close_g = "  </g>"
elif a.notch:
    open_g, close_g = f'  <g mask="url(#{MASK_ID})">', "  </g>"

mask = ""
if a.notch:
    mask = (f'  <mask id="{MASK_ID}">\n'
            f'    <rect width="24" height="24" fill="#fff"/>\n'
            f'    <circle cx="{BADGE_CX}" cy="{BADGE_CY}" r="{BADGE_R}" '
            f'fill="#000"/>\n'
            f'  </mask>\n')

parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" '
    'height="24" fill="currentColor" stroke="none" aria-hidden="true">',
    mask.rstrip("\n") if mask else None,
    open_g or None,
    content,
    close_g or None,
    f'  <g transform="scale({BADGE_SCALE:g})">',
    f'    <path d="{pv}"/>',
    f'    <path d="{ph}"/>',
    "  </g>",
    "</svg>",
]
out = pathlib.Path(a.out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("\n".join(p for p in parts if p) + "\n")
print(f"{pathlib.Path(a.base).name} -> {out}  "
      f"({'stroked sw=' + format(a.stroke_width, 'g') if stroked else 'filled'}"
      f"{', notched' if a.notch else ''}, {out.stat().st_size} bytes)")
