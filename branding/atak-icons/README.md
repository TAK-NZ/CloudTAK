# ATAK icons for CloudTAK

ATAK-CIV icons adapted for CloudTAK's UI. Two separate pieces of work live here:

| | Covers | Doc | Scope |
|---|---|---|---|
| **Right-hand nav menu** | `stores/modules/menu.ts` | this file + [`MAPPING.md`](MAPPING.md) | **decided** -- 16 of 18 |
| **Drawing tools palette** | `components/CloudTAK/DrawTools.vue` | [`DRAWTOOLS.md`](DRAWTOOLS.md) | **decided** -- 12 of 13 |

Neither is wired in yet. The rest of this file covers the nav menu only.

---

## Right-hand nav menu

Replacements for the Tabler icons in CloudTAK's right-hand navigation bar,
extracted from ATAK-CIV and traced to SVG.

**Scope: decided. 16 of the 18 menu entries get the ATAK icon.** Tabler is kept
for `server` (Admin) and `debugger` (COT Debugger) only.

`primary/` and `svg-traced/` contain exactly one file per *adopted* entry -- 16
each -- so what is in those two directories *is* the decision. Everything not
adopted, including the traced Admin and Debugger icons, sits in `alternates/`
and is not shipped.

**Status: not wired in.** Nothing in `api/` references these yet, pending the
v13.70.0 upstream sync. See [Implementation plan](#implementation-plan) for why,
and [`MAPPING.md`](MAPPING.md) for provenance and per-icon notes.

## What gets swapped

All 18 entries of `baseMenuItems` in `api/web/src/stores/modules/menu.ts` are
listed below, including the two that stay on Tabler, so this table describes the
whole nav bar rather than only the changes.

Compare the 16 adopted pairs in
[`contact-sheets/04_tabler_vs_atak_pairs.png`](contact-sheets/04_tabler_vs_atak_pairs.png)
(`_A-tabler` then `_B-atak`, rendered at `stroke-width: 1` to match what the app
actually passes). The two kept-Tabler entries are deliberately absent from that
sheet.

| Menu key | Label | Current Tabler icon | Action |
|---|---|---|---|
| `features` | Your Features | `IconMapPin` | → ATAK `nav_marker` |
| `overlays` | Overlays | `IconBoxMultiple` | → ATAK `nav_overlay_manager` |
| `contacts` | Contacts | `IconUsers` | → ATAK `nav_contacts` |
| `basemaps` | BaseMaps | `IconMap` | → ATAK `nav_maps` |
| `missions` | Data Sync | `IconReplace` | → ATAK `sync_original` **(see note)** |
| `packages` | Data Package | `IconPackages` | → ATAK `nav_data_package` |
| `channels` | Channels | `IconAffiliate` | → ATAK `nav_channels` |
| `videos` | Videos | `IconVideo` | → ATAK `nav_video` |
| `chats` | Chats | `IconMessage` | → ATAK `nav_group_chat` |
| `routes` | Routes | `IconRoute` | → ATAK `nav_routes` |
| `files` | Uploaded Files | `IconFiles` | → ATAK `nav_file` |
| `imports` | Imports | `IconFileImport` | → ATAK `nav_import` |
| `iconsets` | Iconsets | `IconPhoto` | → ATAK `nav_gallery` |
| `connections` | Connections | `IconNetwork` | → ATAK `nav_radio` |
| `history` | History | `IconHistory` | → ATAK `nav_track_history` |
| `settings` | Settings | `IconSettings` | → ATAK `nav_settings` |
| `server` | Admin | `IconServerCog` | **keep Tabler** |
| `debugger` | COT Debugger | `IconBug` | **keep Tabler** |

The override module therefore carries 16 keys. `server` and `debugger` are simply
absent from it and fall through to whatever upstream ships -- no code is needed
to "keep" them.

### Why Admin and Debugger stay on Tabler

Both ATAK candidates were traced and rejected on merit; they are kept in
`alternates/` if the decision is ever revisited.

- `server` (Admin): ATAK's `nav_server` is a plain database cylinder. Tabler's
  `IconServerCog` carries a gear, which conveys administration rather than
  storage.
- `debugger` (COT Debugger): ATAK has no bug glyph. The nearest candidate,
  `nav_toolbars`, is a wrench and screwdriver, which reads as "tools" not
  "debug". Tabler's `IconBug` is unambiguous.

### Note on `missions` (Data Sync)

Uses `missions_datasync_atak_sync_original_bw`, traced from ATAK's
`drawable-hdpi/sync_original.png`. This is the **solid two-arrow sync glyph**,
deliberately chosen over the thin-line `nav_symbols_copy_26` alternative, which
is retained in `alternates/missions_alt_nav_symbols_copy_26.*`.

It is the one genuinely solid icon in the set and reads heavier than the other
15, which are outlines. That is a known and accepted trade: it conveys "sync"
far more directly than Tabler's `IconReplace` (two boxes swapping places), and
ATAK-CIV ships no thin-line Data Sync icon at all -- there is no `datasync` or
`mission` package under `com/atakmap/android/` and no "Data Sync" string in
`strings.xml`, because that tool is a closed plugin.

### On visual weight

The 15 outline icons render close to Tabler at `stroke-width: 1`, only mildly
bolder -- they are filled *outlines of strokes*, not solid shapes. The real
limitation is that they are fills, so `stroke-width` has no effect on them: if
the nav bar's icon weight is ever retuned globally, these will not follow.

## Why this lives in `branding/`

`docs/UPSTREAM-SYNC.md` syncs `api/` and `tasks/` from upstream
dfpc-coe/CloudTAK. Anything placed there becomes conflict surface on every sync.
`branding/` is TAK-NZ-only and never participates in a sync, which is also why
`branding/logo/` and `generate_icons.sh` already live here.

## Contents

| Path | What |
|---|---|
| `MAPPING.md` | Provenance, per-icon notes, licensing, unsuitable-asset audit |
| `primary/` | The 16 adopted source rasters, 192x192, white-on-transparent |
| `svg-traced/` | The 16 traced SVGs -- **the actual deliverable** |
| `alternates/` | 16 unused files: second choices, plus the traced-but-rejected Admin and Debugger icons. Not shipped |
| `contact-sheets/` | Visual indexes. `04_` is the Tabler-vs-ATAK comparison |
| `trace_icons.py` | Tracer for ATAK's white-on-transparent PNGs |
| `trace_datasync.py` | Tracer for ATAK's blue-on-transparent solid sync glyph |
| `requirements.txt` | Pinned tracing toolchain |

The traced SVGs use `viewBox="0 0 24 24"` and `fill="currentColor"`, matching the
Tabler grid the rest of the nav bar uses.

## Source

ATAK-CIV **5.5.1.10**, commit `9f6893dd657feacc35ec5de03dad721c2e44170e`
(`Merge branch 'upstream/5.5.1.10'`), from
`atak/ATAK/app/src/main/res/drawable-xxxhdpi/` and `drawable-hdpi/`.

ATAK-CIV is GPL-3.0. Per that repo's `README.md` and `INTENT.md`, contributions
by US Federal employees are ineligible for copyright in the US (effectively
public domain) and licensed under GPLv3 elsewhere; contractor contributions are
copyrighted GPLv3. There is no per-file authorship metadata on these assets, so
which applies to any given icon cannot be determined from the repository.

Shipping any of these requires an attribution notice. See `MAPPING.md` for the
full licensing discussion. None of the selected icons carry TAK/ATAK branding --
the branded assets were deliberately excluded.

Two assets are **derived works** rather than straight adaptations:
`drawtools/draw-line_line_plus.svg` and `drawtools/draw-sector_cone_plus.svg`
combine Tabler outlines (MIT) with ATAK's `+` badge (GPL-3.0), so attribution
must cover both upstreams. A third, `drawtools/draw-point_point_plus.svg`, is
ATAK-only. See `DRAWTOOLS.md` for how they are composed.

## Regenerating

Requires `librsvg2-bin` and `imagemagick` for the contact sheets, plus a venv.
Run from the repository root, as with `branding/generate_icons.sh`:

```bash
python3 -m venv .venv-trace
.venv-trace/bin/pip install -r branding/atak-icons/requirements.txt

ATAK=../TPC_atak-civ/atak/ATAK/app/src/main/res

# ATAK white-on-transparent line icons -> SVG (whole directory at once)
.venv-trace/bin/python branding/atak-icons/trace_icons.py \
    branding/atak-icons/primary \
    branding/atak-icons/svg-traced

# the solid two-arrow sync glyph (single file, auto-detects alpha keying)
.venv-trace/bin/python branding/atak-icons/trace_datasync.py \
    "$ATAK/drawable-hdpi/sync_original.png" \
    branding/atak-icons/svg-traced/missions_datasync_atak_sync_original_bw.svg
```

Verified reproducible from a clean venv with the pinned versions: the outline
icons come back byte-identical, and `trace_datasync.py` reproduces
`missions_datasync_atak_sync_original_bw.svg` byte-identically from the ATAK
raster.

**Run the two commands in the order shown.** `trace_icons.py` traces every
`*.png` in the input directory, and `primary/` contains a mono PNG of the sync
glyph, so it will also emit its own
`missions_datasync_atak_sync_original_bw.svg` -- traced from that already-traced
PNG rather than from ATAK's original. It is the inferior of the two. Running
`trace_datasync.py` second overwrites it with the good version.

### Caveat if you point the tracers at other ATAK assets

Not every file matching `nav_*.png` is a glyph. Five of ATAK's 77 are widget
chrome or placeholders with baked-in backgrounds -- `nav_menu_closed`,
`nav_menu_opened`, `nav_tool_delete`, `nav_blank`, `nav_empty`. `MAPPING.md`
documents them. `trace_datasync.py` rejects such inputs with an explicit error;
`trace_icons.py` has no such guard and would emit a filled square.

## Implementation plan

Deferred until the pending upstream **v13.70.0** sync lands. At the time of
writing `vendor/upstream` is at v13.70.0 while `.upstream-version` is still
v13.26.0, and `menu.ts` is already conflicting in that merge -- upstream moved
the `missions` icon to `IconAmbulance` where TAK-NZ has `IconReplace`. Doing icon
work first would mean resolving the same lines twice.

When the sync is done, the approach that keeps conflict surface minimal:

1. Add a TAK-NZ-only module, e.g. `api/web/src/base/taknz-nav-icons.ts`, holding
   the icon components and a menu-key -> component map. New files cannot
   conflict. The `taknz-` prefix guarantees upstream never creates the same path.
   `api/web/src/base/` already hosts TAK-NZ-only frontend code.
2. Change `api/web/src/stores/modules/menu.ts` in exactly **two** places: one
   import, and one `.map()` wrapping the `baseMenuItems` return. The upstream
   array itself stays byte-identical, so upstream adding or reordering menu
   entries merges cleanly.
3. Retire the existing inline `IconAmbulance` -> `IconReplace` edit by expressing
   it through the override map. Net conflict surface in `menu.ts` should go down.
4. Add attribution at the repo root, outside `api/` and `tasks/`.

Icon components must satisfy the contract `MenuItemCard.vue` imposes:

```vue
<component :is='icon' v-tooltip='...' :title='tooltip'
           :size='iconSize' :color='resolvedIconColor' stroke='1' class='...' />
```

with `iconSize` 32 for list layout and 36 for tiles, and `resolvedIconColor`
forced to `#fff` when compact. Because the traced icons are **filled** paths
rather than strokes:

- `size` maps to `width`/`height`
- `color` must drive the fill. Simplest correct handling is `:style="{ color }"`
  so `currentColor` resolves, rather than setting a `fill` attribute
- `stroke` must be accepted and **ignored**; left undeclared it falls through to
  the root `<svg>` as the invalid paint value `stroke="1"`

Components should be `markRaw`-wrapped so Vue does not try to make them
reactive. Upstream does this for plugin icons; TAK-NZ currently does not.

Implement with Vue's `h()` in a `.ts` module. Do **not** add `vite-svg-loader`:
that would require editing `vite.config.ts` and `package.json`, both of which are
synced, adding conflict surface and a dependency for little gain.

### Rejected alternatives

- **Plugin API** (`MenuManager.addMenuItem`). Cannot reliably override base
  items. In the `items` getter, `new Map(combined.map(i => [i.key, i]))` lets a
  duplicate key win, but only when `preferenceOrder` is non-empty; otherwise the
  `else` branch keeps both and renders a duplicate row. Plugins also load from
  server config, which is wrong for shipping our own branding.
- **Subclassing `MenuManager`** at its instantiation point in
  `api/web/src/stores/map.ts`. Would leave `menu.ts` untouched, but `map.ts` is
  TAK-NZ's most-modified frontend file (~937 changed lines). Trading two stable
  lines for two in the churn hotspot is a net loss.

The override map carries 16 keys; `server` and `debugger` are absent and fall
through to upstream's icons. `menu.ts` still changes in only the two places
described above regardless of how many icons are swapped, so revisiting the scope
later is confined to the TAK-NZ-only module: add a key to adopt an ATAK icon,
delete one to revert to upstream's.
