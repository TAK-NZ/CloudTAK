#!/usr/bin/env python3
"""
Convert an Android vector drawable (res/drawable/*.xml) to SVG.

This is a *lossless* attribute remap, not a trace: Android's `android:pathData`
uses the same path grammar as SVG's `d`, so the geometry is carried across
exactly. Prefer this over trace_icons.py whenever ATAK ships a vector drawable
for the icon you want -- the result is smaller and exact.

Handled: <vector> viewport, <path> pathData / fillColor / fillType / fillAlpha /
strokeColor / strokeWidth / strokeAlpha / strokeLineCap / strokeLineJoin, and
<group> translate/scale/rotate/pivot.

Output is normalised to a 24x24 viewBox via a scale transform so it matches the
rest of this icon set, and every opaque paint is normalised to `currentColor` so
the icon themes like a Tabler icon (see the MONO note below).

Usage: convert_vector_drawable.py <in.xml> <out.svg>
       convert_vector_drawable.py <in-dir> <out-dir>
"""
import pathlib
import sys
import xml.etree.ElementTree as ET

A = "{http://schemas.android.com/apk/res/android}"
VIEWBOX = 24.0
PREC = 4

# Every ATAK drawing-tool drawable is a single-colour glyph, but they are not
# consistently white. Two real cases in this set:
#   ic_center.xml         fills #000000 -- drawn for a light background, so it
#                         would be invisible in CloudTAK's dark UI
#   ic_edit_calendar.xml  fills "@android:color/white" -- a resource reference,
#                         not a hex literal, which is not valid SVG paint
# Normalising every *opaque* paint to currentColor handles both uniformly and
# lets the icon inherit the surrounding text colour. Fully transparent paints
# are still dropped, so intentional holes survive.
MONO = True


def num(v: str) -> float:
    return float(v.rstrip("dip").rstrip("dp").rstrip("px") or 0)


def fmt(v: float) -> str:
    t = f"{v:.{PREC}f}".rstrip("0").rstrip(".")
    return "0" if t in ("", "-0") else t


def colour(v: str | None) -> str | None:
    """
    Android paint value -> SVG paint, or None if it paints nothing.

    Accepts #RGB / #RRGGBB / #AARRGGBB hex literals and resource references
    such as `@android:color/white`.
    """
    if not v:
        return None
    v = v.strip()

    if v.startswith("#"):
        h = v[1:]
        if len(h) == 8:                          # AARRGGBB
            aa, rgb = h[:2], h[2:]
            if aa == "00":
                return None                      # fully transparent
            v = "#" + rgb
        return "currentColor" if MONO else v

    # Resource reference (@android:color/white, @color/foo). We cannot resolve
    # these without the full resource table; treat as an opaque single colour.
    if v.startswith("@"):
        if v.rsplit("/", 1)[-1].lower() in ("transparent", "none"):
            return None
        return "currentColor" if MONO else None

    return "currentColor" if MONO else v         # named colour, e.g. "white"


def group_transform(g: ET.Element) -> str | None:
    parts = []
    tx, ty = g.get(f"{A}translateX"), g.get(f"{A}translateY")
    sx, sy = g.get(f"{A}scaleX"), g.get(f"{A}scaleY")
    rot = g.get(f"{A}rotation")
    px, py = g.get(f"{A}pivotX") or "0", g.get(f"{A}pivotY") or "0"

    if tx or ty:
        parts.append(f"translate({fmt(num(tx or '0'))},{fmt(num(ty or '0'))})")
    if rot and num(rot):
        parts.append(f"rotate({fmt(num(rot))},{fmt(num(px))},{fmt(num(py))})")
    if sx or sy:
        parts.append(f"scale({fmt(num(sx or '1'))},{fmt(num(sy or '1'))})")
    return " ".join(parts) or None


def path_el(p: ET.Element) -> str | None:
    d = p.get(f"{A}pathData")
    if not d:
        return None
    attrs = [f'd="{" ".join(d.split())}"']

    fill = colour(p.get(f"{A}fillColor"))
    attrs.append(f'fill="{fill}"' if fill else 'fill="none"')

    if (p.get(f"{A}fillType") or "").lower() == "evenodd":
        attrs.append('fill-rule="evenodd"')
    if (fa := p.get(f"{A}fillAlpha")) and num(fa) != 1:
        attrs.append(f'fill-opacity="{fmt(num(fa))}"')

    stroke = colour(p.get(f"{A}strokeColor"))
    sw = p.get(f"{A}strokeWidth")
    # A stroke with no colour, or width 0, paints nothing - skip it entirely.
    if stroke and sw and num(sw) > 0:
        attrs.append(f'stroke="{stroke}"')
        attrs.append(f'stroke-width="{fmt(num(sw))}"')
        if cap := p.get(f"{A}strokeLineCap"):
            attrs.append(f'stroke-linecap="{cap}"')
        if join := p.get(f"{A}strokeLineJoin"):
            attrs.append(f'stroke-linejoin="{join}"')
        if (sa := p.get(f"{A}strokeAlpha")) and num(sa) != 1:
            attrs.append(f'stroke-opacity="{fmt(num(sa))}"')

    return "<path " + " ".join(attrs) + "/>"


def convert(src: pathlib.Path) -> str:
    root = ET.parse(src).getroot()
    if not root.tag.endswith("vector"):
        raise SystemExit(f"error: {src.name} is not a <vector> drawable "
                         f"(root is <{root.tag.split('}')[-1]}>) -- "
                         f"selectors and shapes cannot be converted")

    vw = num(root.get(f"{A}viewportWidth") or "24")
    vh = num(root.get(f"{A}viewportHeight") or "24")
    scale = VIEWBOX / max(vw, vh)

    body: list[str] = []

    def walk(node: ET.Element, depth: int):
        pad = "  " * (depth + 1)
        for child in node:
            tag = child.tag.split("}")[-1]
            if tag == "path":
                if el := path_el(child):
                    body.append(pad + el)
            elif tag == "group":
                tf = group_transform(child)
                if tf:
                    body.append(f'{pad}<g transform="{tf}">')
                    walk(child, depth + 1)
                    body.append(f"{pad}</g>")
                else:
                    walk(child, depth)
            # <clip-path> and <aapt:attr> are ignored; none of the ATAK
            # drawing-tool icons use them.

    # normalise the native viewport onto a 24x24 grid
    body.append(f'  <g transform="scale({fmt(scale)})">')
    walk(root, 1)
    body.append("  </g>")

    if not any("<path" in line for line in body):
        raise SystemExit(f"error: {src.name} produced no paths")

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        'width="24" height="24" fill="currentColor" stroke="none" '
        'aria-hidden="true">\n'
        + "\n".join(body)
        + "\n</svg>\n"
    )


src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
if src.is_dir():
    dst.mkdir(parents=True, exist_ok=True)
    for x in sorted(src.glob("*.xml")):
        try:
            out = dst / (x.stem + ".svg")
            out.write_text(convert(x))
            print(f"{x.name:34s} -> {out.name:34s} {out.stat().st_size:6d} B")
        except SystemExit as e:
            print(f"{x.name:34s} SKIPPED: {e}")
else:
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(convert(src))
    print(f"{src.name} -> {dst}  ({dst.stat().st_size} bytes)")
