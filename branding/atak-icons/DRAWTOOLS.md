# ATAK icons for CloudTAK's drawing tools

Analysis of the drawing tools palette, separate from the right-hand nav bar
covered in `README.md` / `MAPPING.md`.

**Scope: decided. 12 of the 13 entries get a new icon** -- 9 from ATAK plus three
derived icons (Draw Point, Draw Line, Draw Sector). The dropdown trigger keeps
Tabler's `IconPencilPlus`. `drawtools/` holds exactly one file per entry, so
what is in that directory *is* the decision. Unused candidates sit in
`drawtools/rejected/`.

**Status: not wired in**, pending the v13.70.0 upstream sync. Compare before and
after in
[`contact-sheets/05_drawtools_tabler_vs_atak.png`](contact-sheets/05_drawtools_tabler_vs_atak.png)
(`_1-OLD` then `_2-NEW`, `_2-HYBRID` for derived icons, or `_2-UNCHANGED` for
the trigger). The trigger row is rendered against `pencil-plus`, the icon
v13.70.0 actually ships.

## Target

`api/web/src/components/CloudTAK/DrawTools.vue` -- the "Geometry Editing"
dropdown, mounted once at `Map.vue:311`. Icons render with `:size='25'
stroke='1'` and inherit colour; the trigger button uses `:size='40'`.

**12 of 13 entries change.** 9 take an ATAK icon; Draw Point, Draw Line and Draw
Sector take derived icons. The trigger is unchanged.

| # | Tool | Replaces | New icon | Notes |
|---|---|---|---|---|
| — | *trigger* "Geometry Editing" | — | `IconPencilPlus` | **keep Tabler**, see below |
| 1 | Coordinate Input | `IconCursorText` | `ic_target` | |
| 2 | Create Event | `IconCalendarEvent` | `ic_edit_calendar` | upstream-only tool |
| 3 | Range & Bearing | `IconCompass` | `nav_rb` | see *Collision note* |
| 4 | Range Rings | `IconTarget` | `ic_menu_rb_circle` | |
| 5 | Draw Point | `IconPoint` | `draw-point_point_plus` | **derived** |
| 6 | Draw Line | `IconLine` | `draw-line_line_plus` | **derived** |
| 7 | Draw Polygon | `IconPolygon` | `polygon` | thin `+` badge |
| 8 | Draw Rectangle | `IconVector` | `rectangle` | thin `+` badge |
| 9 | Draw Circle | `IconCircle` | `ic_menu_circle` | thin `+` badge |
| 10 | Draw Sector | `IconCone` | `draw-sector_cone_plus` | **derived** |
| 11 | Lasso Select | `IconLasso` | `ic_lasso` | see *Badge note* |
| 12 | GeoJSON Import | `IconFileImport` | `ic_navstack_import` | |

### Why the trigger keeps Tabler

Upstream's refactor changes the trigger from `IconPencil` to **`IconPencilPlus`**
(`DrawTools.vue:9` on `vendor/upstream`), which already carries a `+` in the
lower right -- the same position and role as the badge on the six draw tools. It
is the "create something" affordance for the whole palette, so keeping it is more
consistent with the convention, not less.

ATAK's nearest candidate, `ic_edit_outline`, is a plain pencil with no badge. It
is kept at `drawtools/rejected/ic_edit_outline.svg`.

Earlier revisions of this document compared the ATAK candidate against Tabler's
plain `pencil`, which is the icon on the *current* branch rather than the one the
v13.70.0 merge brings. That was the wrong baseline and made the ATAK option look
better than it is.

### The `+` badge convention

All six draw tools now carry the thin outline `+` that ATAK uses to mean "create
a new one":

| Tool | Icon | Badge from |
|---|---|---|
| *trigger* | `IconPencilPlus` | Tabler (kept) |
| Draw Point | `draw-point_point_plus` | derived -- ATAK `ic_point` + badge |
| Draw Line | `draw-line_line_plus` | derived -- Tabler `line` + badge |
| Draw Polygon | `polygon` | native ATAK |
| Draw Rectangle | `rectangle` | native ATAK |
| Draw Circle | `ic_menu_circle` | native ATAK |
| Draw Sector | `draw-sector_cone_plus` | derived -- Tabler `cone` + badge |

Lasso Select deliberately breaks the pattern: `ic_lasso` carries a **solid filled
disc** badge instead, which separates *select* from *draw* at a glance. Because
the thin-badge convention is now complete across all six draw tools, that
contrast reads more clearly than it did when only three carried a badge.

An earlier revision used `ic_drag_ruler_unselected` for Draw Line -- ATAK's
*Dynamic Range & Bearing* icon. It was replaced by the derived icon, which
removes both the borrowed semantics and the badge inconsistency.

## Why these are the right icons: ATAK's own toolbars

Six of the nine are not guesses. ATAK's drawing and range-and-bearing toolbars
map almost 1:1 onto CloudTAK's palette, so the canonical icon for each tool is
verifiable in the ATAK source rather than chosen by eye.

`res/layout/drawing_toolbar_view.xml`:

| ATAK button | selector | resolves to |
|---|---|---|
| `newCircleButton` | `ic_menu_drawing_circle_toggle` | `ic_menu_circle` |
| `newRectangleButton` | `ic_menu_drawing_rect_toggle` | `rectangle` |
| `newShapeButton` | `sse_shape` | `polygon` |
| `newEllipseButton` | `ic_menu_ellipse_toggle` | `ic_menu_ellipse` |
| `telestration` | `ic_menu_drawing_telestrate_toggle` | `telestrate` |

`res/layout/rab_toolbar.xml`:

| ATAK button | selector | resolves to |
|---|---|---|
| `buttonCircle` (range rings) | `ic_menu_rb_circle_toggle` | `ic_menu_rb_circle` |
| `buttonRangeAndBearing` | `ic_ruler_toggle` | `ic_ruler_unselected` |
| `buttonDynamicRangeAndBearing` | `ic_drag_ruler_toggle` | `ic_drag_ruler_unselected` |
| `buttonBullseye` | `ic_rab_bullseye` | `bullseye` |

In each selector the `_lit` / `_selected` / `_active` variant is the pressed
state; we take the unselected one.

The shape tools carry a `+` badge in ATAK, meaning "create a new one" -- which
matches CloudTAK's "Draw X" labels better than Tabler's bare shapes. Note this
also confirms `telestrate` is a *create freehand shape* tool, not a selection
tool; see the Lasso Select entry under the keeps.

## Badge note: Lasso Select

Adopted `ic_lasso` -- ATAK's real lasso-selection icon, confirmed at
`RegionShapeTool.Mode.LASSO` and `LassoContentProvider.java:68`. See
[`contact-sheets/06_lasso_candidates.png`](contact-sheets/06_lasso_candidates.png),
which shows every candidate at 96px and at the 25px the palette renders.

Its `+` is a **solid filled disc with the cross knocked out**, unlike the thin
outline `+` on the shape tools. That difference is the reason it was adopted: it
separates *select* from *draw* at a glance.

Be aware the `+` convention is only partial. Of the six draw tools, three carry
the thin outline badge (`polygon`, `rectangle`, `ic_menu_circle`) and three carry
none at all (`ic_point`, plus Tabler's line and cone). So the contrast is against
those three specifically, not a uniform system.

The counter-argument, for the record: a select action creates nothing, so a badge
of any style arguably overstates it, and Tabler's unbadged lasso would signal
that more accurately. The filled-disc distinction was preferred as the clearer
visual grouping cue.

Theme safety was verified -- the cross is a transparent hole (`fill-rule
evenodd`, a single `currentColor` fill), not a hardcoded colour, so it inverts
correctly on CloudTAK's light theme instead of disappearing.

Two other candidates were rejected, both kept in `drawtools/rejected/`:

| Candidate | Why not |
|---|---|
| `nav_lasso` | A loop with a tapering tail but **no cinch knot** -- the feature that makes a lasso legible. At 25px it reads as a speech bubble with a `+`. Not referenced anywhere in the ATAK source |
| `telestrate` | ATAK's *telestration* icon (`TelestrationTool`, freehand drawing and annotation), carrying the same create badge as the shape tools. Depicts drawing a freehand shape, not selecting with one |

## Collision note: Range & Bearing

ATAK's canonical R&B icon is `ic_ruler_unselected`, but it is two circles joined
by a line -- **visually almost identical to Tabler's `IconLine`**, which the
recommendation keeps for Draw Line. Two adjacent rows in the same dropdown would
look the same. `ic_drag_ruler_unselected` differs only by a dash pattern, which
does not survive 25px.

So R&B uses `nav_rb` instead: an arrow above a measurement scale, conveying
bearing *and* range, and distinct from every other icon in the palette. It is
also ATAK's own nav-menu R&B icon, so it keeps the semantic authority. Both
rejected rulers are kept in `drawtools/rejected/`.

This is the only case in the set where the canonical ATAK icon had to be passed
over.

## The derived icons

Three entries use icons composed by `make_plus_badge.py`, which grafts ATAK's `+`
create badge onto a base icon. The badge bars are lifted **verbatim** from an
already-converted ATAK icon (`rectangle.svg`), so every badge in the set is
byte-identical rather than redrawn.

| Icon | Base | Notch | Stroke |
|---|---|---|---|
| `draw-point_point_plus` | ATAK `ic_point` (fill) | no | n/a |
| `draw-line_line_plus` | Tabler `line` (stroke) | no | baked 1.1 |
| `draw-sector_cone_plus` | Tabler `cone` (stroke) | **yes** | baked 1.1 |

### Notching

ATAK does not sit its badge *beside* the shape -- it cuts a hole so the badge
sits inside. Reproduced with an SVG `mask`: a circle r=4.3 at (19.56, 18.84), the
measured badge centre. Masks are luminance-based rather than colour-based, so
this is theme-independent; verified rendering correctly on both CloudTAK themes.

Only notch when the base actually collides with the badge. Measured ink inside
the badge disc:

| Base | Ink in badge disc | Notch |
|---|---|---|
| Tabler `cone` | 3075 px | yes |
| Tabler `line` | 0 px | no |
| ATAK `ic_point` | 0 px | no |

Notching a base that does not collide just erases part of it for nothing.

### Stroke weight

Baked in for stroke-based bases, because these icons ignore the `stroke` prop --
the ATAK ones are fills and cannot honour it. Match ATAK's *apparent* weight, not
its nominal one: round caps and antialiasing make rendered thickness heavier than
`stroke-width` suggests. Measured in 24-space:

| | apparent |
|---|---|
| ATAK `rectangle` | 1.20 |
| ATAK `ic_menu_circle` | 1.26 |
| ATAK `polygon` | 1.44 |
| derived at `stroke-width` 1.0 | 1.14 |
| **derived at `stroke-width` 1.1** | **1.26** |
| derived at `stroke-width` 1.2 | 1.38 |

So 1.1 is the value that blends. Scaling the base down to free the corner was
tried first and rejected -- it left the badge visibly detached and the base
smaller than its neighbours.

### Two consequences

1. `draw-sector_cone_plus` is the only icon carrying an `id`
   (`taknz-plus-notch`), because it is the only notched one. If these are ever
   inlined into a single document rather than rendered as separate components,
   that id must stay unique.
2. Stroke weight is baked, so like the ATAK fills these will not respond to a
   `stroke-width` prop.

### Licensing

`draw-line_line_plus` and `draw-sector_cone_plus` combine Tabler (MIT) with
ATAK-CIV (GPL-3.0) artwork, so they are **derived works** and attribution must
cover both upstreams. `draw-point_point_plus` is ATAK-only.

## Source format: vector, not traced

Every ATAK icon here except `nav_rb` ships as an **Android vector drawable**
(`res/drawable/*.xml`), so `convert_vector_drawable.py` remaps it to SVG
losslessly -- `android:pathData` uses the same grammar as SVG's `d`. This is
strictly better than tracing:

| | traced from raster | converted from vector |
|---|---|---|
| geometry | approximated | exact |
| size | 2-9 KB | 0.3-3.5 KB |
| re-derivable | depends on tracer settings | deterministic |

`nav_rb` is the exception -- it exists only as a raster, so it went through
`trace_icons.py`.

Prefer the converter over the tracer whenever ATAK ships a vector for the icon
you want. Note that only 174 of the 397 files in `res/drawable/` are actually
`<vector>` drawables; the rest are selectors, shapes and state lists. The
converter rejects those with an explicit error rather than emitting nonsense.

### Two conversion quirks worth knowing

The ATAK drawing drawables are not uniformly white-filled, and both cases below
produced broken output before the converter was fixed:

- `ic_center.xml` fills `#000000` -- drawn for a light background. Converted
  naively it is invisible in CloudTAK's dark UI.
- `ic_edit_calendar.xml` fills `@android:color/white`, a resource reference
  rather than a hex literal, which is not valid SVG paint.

The converter now normalises every *opaque* paint to `currentColor` (its `MONO`
setting). Fully transparent paints are still dropped so intentional holes
survive. `ic_menu_ellipse.xml` is also stroke-based rather than filled, which
converts correctly but is worth knowing if stroke weights ever need adjusting.

## Upstream drift

`DrawTools.vue` is upstream-owned and **already refactored on
`vendor/upstream`** (110 insertions / 92 deletions vs the current branch):

- the hardcoded `<div>` rows became a keyed array,
  `const drawTools: DrawToolItem[]` with `{ key, label, icon, action }`
- rendering became dynamic: `<component :is='tool.icon' :size='25' stroke='1' />`
- a new tool was added: `{ key: 'event', label: 'Create Event',
  icon: IconCalendarEvent }`
- the trigger changed from `IconPencil` to `IconPencilPlus`
- a search box and `filteredDrawTools` computed filter were added

Two consequences:

1. Do not edit the current hardcoded template -- that work would be thrown away
   by the v13.70.0 merge.
2. The keyed array is a far better override point than the nav bar had. Express
   replacements as a map keyed on the upstream `key` values (`coordinate`,
   `event`, `range`, `range_rings`, `point`, `line`, `polygon`, `rectangle`,
   `circle`, `sector`, `lasso`, `import`), mirroring the approach in
   `README.md`.

Unlike the left menu, there is **no plugin or override mechanism** for drawing
tools -- `drawTools` is local to the component. So the same two-line pattern
applies: one import, one `.map()` over the array.

### Also worth swapping in the same pass

These modals repeat the same iconography in their headers, and would look
inconsistent if only the palette changed:

- `Inputs/RangeInput.vue:13` -- `IconCompass`, "Range & Bearing"
- `Inputs/RangeRingsInput.vue:12` -- `IconTarget`, "Range Rings"
- `Inputs/GeoJSONInput.vue:12` -- `IconFileImport`

All three are upstream-owned.

## Contents

- `drawtools/*.svg` -- the 12 adopted icons: 9 from ATAK plus three derived
  (`draw-point_point_plus`, `draw-line_line_plus`, `draw-sector_cone_plus`). The
  trigger has no file here -- it keeps Tabler's `IconPencilPlus`
- `drawtools/rejected/*.svg` -- 9 not shipped. Eight were considered and passed
  over (`ic_edit_outline`, `ic_ruler_unselected`, `ic_drag_ruler_unselected`,
  `telestrate`, `bullseye`, `ic_center`, `ic_pick_date`, `ic_menu_ellipse`);
  `ic_point` is retained because it is the **base** for
  `draw-point_point_plus`
- `make_plus_badge.py` -- composes the derived icons
- `convert_vector_drawable.py` -- the vector drawable to SVG converter

### Regenerating

```bash
ATAK=../TPC_atak-civ/atak/ATAK/app/src/main/res/drawable
TAB=api/web/node_modules/@tabler/icons/icons/outline
B=branding/atak-icons

# 1. ATAK vector drawables -> SVG (lossless, stdlib only, no venv)
python3 $B/convert_vector_drawable.py "$ATAK/polygon.xml" $B/drawtools/polygon.svg

# 2. derived icons: base + ATAK's "+" badge
python3 $B/make_plus_badge.py "$B/drawtools/rejected/ic_point.svg" \
    $B/drawtools/draw-point_point_plus.svg
python3 $B/make_plus_badge.py "$TAB/line.svg" \
    $B/drawtools/draw-line_line_plus.svg --stroke-width 1.1
python3 $B/make_plus_badge.py "$TAB/cone.svg" \
    $B/drawtools/draw-sector_cone_plus.svg --stroke-width 1.1 --notch
```

`make_plus_badge.py` refuses to run if a stroke-based base is given no
`--stroke-width`, or a fill-based base is given one, since either would silently
produce a wrong-weight icon. It also aborts if the badge bars are not the first
two paths in the badge source, so a change to `rectangle.svg` cannot quietly
corrupt every derived icon.

Both scripts need only the Python standard library. `nav_rb.svg` came from
`trace_icons.py`, which does need the venv from `requirements.txt`.
