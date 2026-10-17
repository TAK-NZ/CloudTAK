#!/usr/bin/env python3
"""
Build library/ -- every ATAK nav_*.png that is not already adopted in primary/
and is clean white line art, as source PNG plus traced SVG.

Steps:
  1. Collect nav_*.png from the res/drawable-*dpi dirs, one file per name,
     from the highest density available (xxxhdpi preferred).
  2. Drop the 15 nav_ icons adopted in primary/ and the five documented
     non-glyph files (nav_menu_closed, nav_menu_opened, nav_tool_delete,
     nav_blank, nav_empty -- see MAPPING.md).
  3. Check each remaining PNG is white/near-white line art on transparency.
     Anything else is reported as skipped and never traced, because
     trace_icons.py has no bad-input guard and would emit a filled shape.
  4. Stage the conforming PNGs in a temp dir and run trace_icons.py on it.
  5. Write library/png/<name>.png and library/svg/<name>.svg.

Needs the tracing venv only because trace_icons.py does. This script itself
uses the standard library and Pillow. Output is deterministic.

Usage (from the repository root, inside the tracing venv):
  python branding/atak-icons/build_nav_library.py ../TPC_atak-civ/atak/ATAK/app/src/main/res
"""
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "library"

# Lowest to highest. nodpi/anydpi are not density buckets; they rank last.
DENSITIES = ["ldpi", "mdpi", "tvdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]

# Widget chrome and placeholders with baked-in backgrounds (MAPPING.md).
NON_GLYPH = {"nav_menu_closed", "nav_menu_opened", "nav_tool_delete", "nav_blank", "nav_empty"}

OPAQUE = 128          # alpha at or above this counts as ink (same cut-off trace_icons.py uses)
MIN_CHANNEL = 230     # white / near-white
MAX_INK_SHARE = 0.5   # more than this is a plate or background, not line art
MIN_INK_SHARE = 0.005  # less than this is effectively empty


def adopted_names() -> set:
    names = set()
    for p in (HERE / "primary").glob("*.png"):
        m = re.search(r"(nav_.+)$", p.stem)
        if m:
            names.add(m.group(1))
    return names


def collect(res: pathlib.Path) -> dict:
    """name -> (density, path), highest density per name."""
    best = {}
    for d in sorted(res.glob("drawable-*")):
        density = d.name[len("drawable-"):]
        if density not in DENSITIES:
            continue
        for p in sorted(d.glob("nav_*.png")):
            cur = best.get(p.stem)
            if cur is None or DENSITIES.index(density) > DENSITIES.index(cur[0]):
                best[p.stem] = (density, p)
    return best


def check(png: pathlib.Path):
    """Return None if the PNG is white line art with alpha, else the reason."""
    im = Image.open(png).convert("RGBA")
    w, h = im.size
    if w != h:
        return f"not square ({w}x{h})"
    raw = im.tobytes()
    ink = [(r, g, b) for r, g, b, a in zip(raw[0::4], raw[1::4], raw[2::4], raw[3::4]) if a >= OPAQUE]
    share = len(ink) / (w * h)
    if share < MIN_INK_SHARE:
        return f"almost empty ({share:.1%} opaque)"
    if share > MAX_INK_SHARE:
        return f"mostly opaque ({share:.1%}), baked-in background"
    low = min(min(c) for c in ink)
    if low < MIN_CHANNEL:
        return f"not white ink (darkest opaque channel {low})"
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    res = pathlib.Path(sys.argv[1]).resolve()
    adopted = adopted_names()
    found = collect(res)

    traced, skipped = [], []
    for name in sorted(found):
        density, path = found[name]
        if name in adopted:
            continue
        if name in NON_GLYPH:
            skipped.append((name, density, "documented non-glyph file (MAPPING.md)"))
            continue
        reason = check(path)
        if reason:
            skipped.append((name, density, reason))
        else:
            traced.append((name, density, path))

    with tempfile.TemporaryDirectory() as tmp:
        stage_in, stage_out = pathlib.Path(tmp) / "in", pathlib.Path(tmp) / "out"
        stage_in.mkdir()
        for name, _, path in traced:
            shutil.copyfile(path, stage_in / f"{name}.png")
        subprocess.run(
            [sys.executable, str(HERE / "trace_icons.py"), str(stage_in), str(stage_out)],
            check=True, stdout=subprocess.DEVNULL,
        )
        if OUT.exists():
            shutil.rmtree(OUT)
        (OUT / "png").mkdir(parents=True)
        (OUT / "svg").mkdir()
        for name, _, _ in traced:
            shutil.copyfile(stage_in / f"{name}.png", OUT / "png" / f"{name}.png")
            shutil.copyfile(stage_out / f"{name}.svg", OUT / "svg" / f"{name}.svg")

    print(f"adopted (excluded): {len(adopted)}")
    print(f"traced: {len(traced)}")
    for name, density, path in traced:
        w = Image.open(path).size[0]
        print(f"  {name}\t{density}\t{w}px")
    print(f"skipped: {len(skipped)}")
    for name, density, reason in skipped:
        print(f"  {name}\t{density}\t{reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
