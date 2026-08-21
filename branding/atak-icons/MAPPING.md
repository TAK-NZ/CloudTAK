# ATAK -> CloudTAK right-hand nav icon mapping

Source: ATAK-CIV 5.5.1.10 (`/home/ubuntu/GitHub/TAK-NZ/TPC_atak-civ`, commit 9f6893d,
`Merge branch 'upstream/5.5.1.10'`), from
`atak/ATAK/app/src/main/res/drawable-xxxhdpi/` (192x192 PNG, white-on-transparent)
unless noted.

Target: `baseMenuItems` in
`api/web/src/stores/modules/menu.ts` -- the single source of truth for the
right-hand nav bar. Nothing has been changed in CloudTAK yet.

**Scope is decided: 16 of the 18 entries take the ATAK icon.** Tabler is kept for
`server` (Admin) and `debugger` (COT Debugger). The "Confidence" column below
records how faithful each match is, not whether it was adopted -- the two
rejected rows are marked. See
`README.md` for the adopted list and `contact-sheets/04_tabler_vs_atak_pairs.png`
for the side-by-side.

## Primary set (`primary/`, `svg-traced/`)

| CloudTAK key | Label | Current Tabler icon | ATAK source | Confidence |
|---|---|---|---|---|
| `features` | Your Features | `IconMapPin` | `nav_marker.png` | good |
| `overlays` | Overlays | `IconBoxMultiple` | `nav_overlay_manager.png` | exact - ATAK's own Overlay Manager icon |
| `contacts` | Contacts | `IconUsers` | `nav_contacts.png` | exact |
| `basemaps` | BaseMaps | `IconMap` | `nav_maps.png` | exact |
| `missions` | Data Sync | `IconReplace` | `sync_original.png` (solid) | substitute - see note 1 |
| `packages` | Data Package | `IconPackages` | `nav_data_package.png` | exact - see note 2 |
| `channels` | Channels | `IconAffiliate` | `nav_channels.png` | exact - see note 2 |
| `videos` | Videos | `IconVideo` | `nav_video.png` | exact |
| `chats` | Chats | `IconMessage` | `nav_group_chat.png` | exact |
| `routes` | Routes | `IconRoute` | `nav_routes.png` | exact |
| `files` | Uploaded Files | `IconFiles` | `nav_file.png` | good (single doc, not stacked) |
| `imports` | Imports | `IconFileImport` | `nav_import.png` | exact |
| `iconsets` | Iconsets | `IconPhoto` | `nav_gallery.png` | exact |
| `connections` | Connections | `IconNetwork` | `nav_radio.png` | weak - broadcast tower, not a network graph |
| `server` | Admin | `IconServerCog` | `nav_server.png` | **NOT ADOPTED** - plain database cylinder; Tabler's gear conveys administration |
| `history` | History | `IconHistory` | `nav_track_history.png` | exact - ATAK's own Track History icon |
| `settings` | Settings | `IconSettings` | `nav_settings.png` | exact |
| `debugger` | COT Debugger | `IconBug` | `nav_toolbars.png` | **NOT ADOPTED** - wrench/screwdriver reads as "tools", not "debug" |

### Note 1 - Data Sync
ATAK-CIV has no Data Sync tool icon. There is no `datasync` or `mission` package
under `atak/ATAK/app/src/main/java/com/atakmap/android/`, and `strings.xml`
(6211 lines) has no "Data Sync" string -- that tool ships as a closed plugin.
**Adopted:** `sync_original.png`, traced to
`svg-traced/missions_datasync_atak_sync_original_bw.svg`. It is the solid
two-arrow sync glyph -- see the section below for how it was traced.

Two thin-line alternatives were considered and rejected:

- `missions_alt_nav_symbols_copy_26.*` -- a two-arrow circular loop. Style-
  consistent with the other 15 icons, but reads less immediately as "sync".
- `missions_alt_nav_restart.png` -- near-identical to the above (7926 pixels
  differ) but carries "restart" semantics inside ATAK.

The other `sync_*.png` files in `drawable/` and `drawable-hdpi/` are legacy
colour 3D-style glyphs (blue gradient arrows, globe) and are not usable.

## The adopted Data Sync icon: solid two-arrow glyph

The icon used for `missions`, traced from ATAK's own solid-style sync glyph.
See `contact-sheets/03_datasync_traced_from_atak.png`.

- Source: ATAK `drawable-hdpi/sync_original.png` (48x48, blue on transparent --
  the only density it ships at)
- Traced SVG: `svg-traced/missions_datasync_atak_sync_original_bw.svg` (3775 bytes)
- Mono PNG: `primary/missions_datasync_atak_sync_original_bw.png` (192x192,
  verified pure white + alpha, matching the ATAK `nav_*` convention)
- Script: `trace_datasync.py`

Despite the 48x48 source, the trace holds up: verified faithful at 32px, 96px
and 240px. At 32px -- the size CloudTAK actually renders -- it is
indistinguishable from a trace of the same design at 240x240.

### Tracing notes

**Binarise last, not first.** The first attempt thresholded the source and then
upsampled the binary mask. That is adequate for a 240px source but destroys a
48px one: edge antialiasing carries sub-pixel shape information, and discarding
it early leaves a staircase that becomes the dominant feature, with the arrow
tips rounded off entirely. The script keeps coverage continuous through crop and
resample, and thresholds once at the end.

**Contour smoothing matters more than potrace's tolerance settings.** Soft-edged
sources threshold to a pixel-jagged boundary and potrace answers with hundreds
of tiny segments. Tolerance tuning alone did not move the file size at all
(18.4 KB regardless). A blur pass before the final threshold cut it roughly 4x
with no visible change. Smoothing is expressed as a fraction of the working
resolution rather than in source pixels, so it scales with any input.

Tracing happens at a fixed 660x660 working resolution, so results do not depend
on the source's own resolution.

`trace_datasync.py` auto-detects two source conventions -- alpha keying for a
glyph on a transparent field, distance-from-white for a glyph on an opaque white
field. Only the alpha path is needed for `sync_original.png`; the white path is
retained so the script stays usable on either kind of input.

### Caveat: style

This is a solid filled glyph. Every other icon in the CloudTAK nav bar -- Tabler
and ATAK `nav_*` alike -- is thin line art. It reads noticeably heavier than its
neighbours; this is visible in the last tile of
`contact-sheets/04_tabler_vs_atak_pairs.png`. It will not blend the way the ATAK
line icons do -- it is the only solid glyph among the 16, the other 15 being
outlines that render close to Tabler at `stroke-width: 1`. This was accepted
deliberately: ATAK-CIV ships no thin-line Data Sync icon, and the solid glyph
conveys "sync" better than Tabler's `IconReplace`. The style-consistent
alternative is `nav_symbols_copy_26`, regenerable from
`drawable-xxxhdpi/nav_symbols_copy_26.png` with `trace_icons.py`.

## Unsuitable source assets

Not every file matching `nav_*.png` is a glyph icon. An audit of all 77 icons in
`drawable-xxxhdpi/` measured transparency share, mean ink luminance and mean
saturation. 72 are clean: pure white ink (mean luminance exactly 255.0), zero
saturation, 65-91% fully transparent. Five are not:

| File | What it actually is |
|---|---|
| `nav_menu_closed.png` | Drawer toggle button. 0% transparent: a 70%-opaque black plate (rgba 0,0,0,179) with a khaki glyph (205,200,176) |
| `nav_menu_opened.png` | Same, the open state |
| `nav_tool_delete.png` | Drag-to-delete drop target. 97.3% opaque, solid khaki plate (218,212,188) with **black** ink |
| `nav_blank.png` | Near-invisible placeholder. Mean alpha 45, only 1.6% opaque |
| `nav_empty.png` | Empty-slot indicator. Mostly a flat 20%-opaque black wash with a white dashed border |

These are widget chrome and placeholders, not icons, which is why they carry
baked-in backgrounds. **None of them are in the primary or alternate sets**, so
nothing here needs fixing. `ic_channels.png` (a `channels` alternative) was
checked separately and is clean.

They would matter if the tracers were pointed at them: `trace_icons.py` keys on
alpha, so a 97%-opaque plate traces as a filled square rather than a glyph, and
`nav_blank.png` would yield almost nothing. `trace_datasync.py` now rejects
inputs whose keyed foreground exceeds 90% with an explicit error rather than
silently emitting a black box. `trace_icons.py` has no such guard -- it was only
ever run over the vetted 18.

### Note 2 - verified as ATAK's official tool icons
Confirmed by source reference, not guesswork:
- `nav_channels` -> `android/channels/ChannelsMapComponent.java:47` and
  `channels/ui/overlay/ChannelsOverlayListModel.java:83`
- `nav_data_package` -> `android/missionpackage/MissionPackageMapComponent.java:356`
  and `app/DeviceSetupWizard.java:123`
- `nav_overlay_manager` -> `res/layout/view_tak_nav.xml:45`
- `nav_track_history` -> `android/track/TrackHistoryComponent.java:101`

## Considered and not adopted

None of these are kept as files -- they are recorded here so the decisions are
traceable, and all are regenerable from the pinned ATAK commit with the scripts
in this folder.

| ATAK icon | Considered for | Why not |
|---|---|---|
| `nav_symbols_copy_26` | `missions` | Thin-line sync loop, style-consistent with the other 15, but reads less clearly as "sync" than the adopted solid glyph |
| `nav_restart` | `missions` | Near-identical to the above (7926 pixels differ) but means "restart" in ATAK |
| `nav_server` | `server` (Admin) | Plain database cylinder; Tabler's `IconServerCog` gear conveys administration better |
| `nav_toolbars` | `debugger` | Wrench/screwdriver reads as "tools"; ATAK has no bug glyph |
| `nav_package` | `packages` | Near-identical to the adopted `nav_data_package` |
| `ic_channels` | `channels` | xhdpi only (96x96); `nav_channels` ships at six densities |
| `nav_point` | `features` | Pin with a "+", which implies create rather than browse |
| `nav_grid` | `overlays` | Grid, less apt than the adopted layers glyph |
| `nav_export`, `nav_info`, `nav_alert`, `nav_plugins` | — | Extracted during the survey, no matching menu entry |

## Directories

- `primary/` -- the 16 adopted source PNGs (192x192) renamed to
  `<cloudtak-key>_<atak-name>.png`, one per adopted menu entry
- `svg-traced/` -- the 16 adopted icons as SVG (see CAVEAT below)
- `contact-sheets/` -- visual indexes
- `trace_icons.py` -- tracer for the ATAK white-on-transparent PNGs
- `trace_datasync.py` -- tracer for the blue-on-white data sync raster

Both scripts need the venv at `/tmp/tracevenv` (`potracer`, `pillow`, `numpy`).
Everything here lives under `/tmp` and will not survive a reboot.

## CAVEAT on `svg-traced/`

These are **outline traces**, produced with potrace via the `potracer` Python
package. Verified visually indistinguishable from the source PNGs at both 32px
and 96px. Total 53 KB for 18 icons (avg ~2.9 KB).

But they are **filled paths, not strokes**. Consequences:

1. `fill="currentColor"` works, so they theme correctly.
2. `stroke-width` does nothing. CloudTAK renders every Tabler icon with
   `stroke='1'`, so these will not thin out in sympathy with their neighbours.
   Stroke weight is baked in at whatever ATAK chose.
3. Each stroke is a closed outline, so the paths are not hand-editable in any
   meaningful sense.

For strokeable output you need **centreline** tracing (`autotrace -centerline`,
or Inkscape's centreline trace extension), not outline tracing. potrace cannot
do it.

## Licensing

ATAK-CIV is GPL-3.0. Per the repo's `README.md` / `INTENT.md`, work by US Federal
employees is public domain in the US and GPLv3 elsewhere; contractor
contributions (PAR Government et al.) are copyrighted GPLv3. There is no
per-file authorship metadata on these assets -- `git log` on
`nav_channels.png` yields only `Commit for 5.5.1.1` -- so you cannot tell which
bucket any given icon falls in.

CloudTAK's root `LICENSE` is AGPL-3.0, which can absorb GPLv3 material
(AGPLv3 s13); the GPLv3 parts stay GPLv3 and need notices preserved.
Note `api/package.json` declares `"license": "ISC"`, which contradicts the root
LICENSE and is incompatible with GPLv3 -- resolve that first.

None of these icons carry TAK/ATAK branding (the branded assets are
`atak_splash.png`, `ic_mil_atak_launcher.png`, and the `*_atak_*` themed
widgets, all excluded here).
