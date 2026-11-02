# Open Waters Overlays (Seamap and Seascape)

How to add two maritime vector overlays from [Open Waters](https://openwaters.io) to CloudTAK:

| Overlay | What it draws | Style file |
|---------|---------------|------------|
| **Seamap** | Nautical chart symbols: buoys, beacons, lights and light sectors, hazards, rocks and wrecks, traffic separation schemes, restricted areas, cables and pipelines, coastline | `config/Seamap_Vector_Map_Styles/Seamap_Overlay_CDN.migrated.json` |
| **Seascape** | Bathymetry: depth areas, depth contours with labels, soundings, unsurveyed-area pattern | `config/Seamap_Vector_Map_Styles/Seascape_Overlay_CDN.migrated.json` |

Both are overlays: they draw on top of whichever basemap is selected. They are independent, so
you can add either one or both. Put Seascape below Seamap in the overlay list.

> **Not for navigational use.** Open Waters states that Seamap is built from crowd-sourced
> OpenStreetMap data and that Seascape depths are not reduced to a chart datum and ignore tides.
> Do not rely on either for navigation. Tell your users this wherever you publish the overlays.

## Why these are not a plain "import a style URL"

Open Waters publishes a full MapLibre style (`https://tiles.openwaters.io/seamap/style.json`).
CloudTAK cannot load it directly, because a CloudTAK basemap or overlay is **one tile source plus
a flat list of layers**. The style files in `config/` are that upstream style reduced to that
shape:

- Only the layers that use one vector tile source were kept: Seamap has 55 layers, Seascape has 5.
  The Seascape layers come from the copies inside Seamap's own `style.json`, not from
  `seascape/style.json`, because those are the ones the Open Waters viewer draws (smaller, plain
  depth numbers and different contour rules).
- Each layer's `source` was set to a placeholder name. CloudTAK replaces it with the overlay's
  own id and prefixes every layer id with the overlay id when the styles are saved.
- Label fonts were changed to `Open Sans Bold`, the only font face the app declares.
- Left out on purpose:
  - The upstream base map (VersaTiles: roads, buildings, place names, boundaries), the land
    fill, the land relief and hillshade, and the OSM raster. They need other tile sources, or
    the land fill would hide the basemap's land.
  - The Seascape depth shading (`color-relief`) and hillshade. They need the Seascape DEM, but
    CloudTAK applies hillshade from one shared terrain source, normally your land elevation.
    Drawing Seascape depth colours from the land DEM would be wrong.
  - The Seascape source coverage layers, which are hidden in the upstream style.

## Prerequisites

1. **Admin access.** Styles are edited from **Admin > Overlays**, which needs a system admin.
2. **A CloudTAK build that includes the Open Waters sprite.** Both overlays draw symbols from a
   sprite sheet (`freenauticalchart`). Seamap uses it for buoys, lights and other point symbols,
   and Seascape uses it for the unsurveyed-area pattern. It is registered in
   `app/src/stores/map.ts` and skipped by `IconManager` in `app/src/stores/modules/icons.ts`.
   If your deployment predates this change, redeploy first (see [Troubleshooting](#troubleshooting)).
3. **`https://tiles.openwaters.io` in `CLOUDTAK_TILE_ORIGINS`.** Required for both overlays. The
   browser loads the sprite directly from `tiles.openwaters.io`, and the Content-Security-Policy
   blocks it unless the origin is listed. The same entry also lets the browser fetch tiles
   straight from the CDN. Without it, tiles go through the CloudTAK tile proxy.

   `CLOUDTAK_TILE_ORIGINS` is a comma-separated list of origins, including the scheme:

   ```
   CLOUDTAK_TILE_ORIGINS=https://basemaps.linz.govt.nz,https://tiles.openwaters.io
   ```

   Keep any origins that are already in the list. Set it in `s3://<config bucket>/cloudtak-config.env`
   (it only applies with `--context useS3CloudTAKConfigFile=true`, see
   [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) and `cloudtak-config.env.example`), then redeploy
   or restart the API tasks. The CSP is generated when the container starts, so the change does
   not take effect before that. The config buckets are not versioned, so keep a copy of the file
   before you edit it.

   *Status for TAK-NZ:* the origin was added to both the Test (us-west-2) and Demo
   (ap-southeast-2) config files on 2026-11-02. Each API service needs a new deployment after a
   change like that to pick it up.

## Add an overlay

Repeat these steps once for each overlay, using the values in the tables below.

1. Open **Admin > Overlays** and choose **New Overlay** (`/admin/overlay/new`).
2. Leave **Ownership** as it is. Choose the **ZXY** source type.
3. Fill in the fields from the table for your overlay.
4. Expand **Advanced Options** and set the remaining fields.
5. In the **Styles** section, switch to **Code View** (the code icon in the section header, field
   placeholder `GL JS Style JSON`). Paste the full contents of the matching JSON file from
   `config/Seamap_Vector_Map_Styles/`. It is a JSON array, so it starts with `[` and ends with `]`.
6. Choose **Submit**.

The basemap editor under **Basemaps & Overlays** has no style editor. Use **Admin > Overlays**
for these two, or edit the styles later from the same page.

### Seamap

| Field | Value |
|-------|-------|
| Name | `Seamap` (any name you like) |
| URL | `https://tiles.openwaters.io/seamap/{z}/{x}/{y}.pbf` |
| Basemap / Overlay | Overlay |
| Type | `vector` |
| Format | `mvt` |
| MinZoom / MaxZoom | `0` / `14` |
| Tile Size | **`512`** |
| Attribution | `© Open Waters: Seamap © OpenStreetMap contributors` |
| Access Scope | `server` (so all users see it) |
| Styles | contents of `Seamap_Overlay_CDN.migrated.json` |

### Seascape

| Field | Value |
|-------|-------|
| Name | `Seascape` (any name you like) |
| URL | `https://tiles.openwaters.io/seascape/{z}/{x}/{y}.pbf` |
| Basemap / Overlay | Overlay |
| Type | `vector` |
| Format | `mvt` |
| MinZoom / MaxZoom | `4` / `15` |
| Tile Size | **`512`** |
| Attribution | `© Open Waters` |
| Access Scope | `server` |
| Styles | contents of `Seascape_Overlay_CDN.migrated.json` |

Notes on the values:

- **Tile Size must be `512`.** The CloudTAK form defaults to 256, so change it. With 256, MapLibre
  loads tiles one zoom level deeper than the map zoom and evaluates zoom-dependent line widths and
  label rules one level deeper too. Test renders at the same spot showed the result: far more depth
  soundings and contours, thicker coastline and dashed boundary lines, and extra place labels.
  At 512 it matches the Open Waters viewer.
- **Attribution is a licence condition.** Open Waters tiles, styles and sprites are CC BY 4.0, and
  Seamap derives from OpenStreetMap (ODbL). Keep the attribution text above.
- The **Feature Title Field** and **Snapping** options are optional and not needed for display.

## Check that it works

1. Open CloudTAK, then **Basemaps & Overlays**, and enable the new overlay.
2. Zoom to a coastline. Seamap shows the coastline outline and light sectors, and buoys and lights
   from about zoom 6 to 10 depending on their importance. Seascape shows depth areas and contours
   from zoom 6, soundings from zoom 7 and contour labels from zoom 8.
3. In the browser developer tools, Network tab, check that
   `https://tiles.openwaters.io/seamap/sprites/freenauticalchart.json` (and `.png`, or `@2x`
   on high-density screens) return `200`, and that the console has no CSP errors.

Both overlays are drawn above the basemap. Keep Seascape below Seamap, so that the chart symbols
are not covered by depth areas. Reorder them in the overlay list if needed.

## How it differs from the Open Waters viewer

With a LINZ or other topographic basemap underneath, the result matches the viewer's chart
symbols, depth areas, contours and soundings. These parts of the viewer are not reproduced:

- The graduated depth shading from the Seascape DEM, and land relief and hillshade. CloudTAK
  applies hillshade from one shared terrain source, so these cannot be separate overlays.
- The VersaTiles base layers: roads, buildings, place names, boundaries and water labels. Your
  basemap supplies its own.
- The tan land fill. It was tried as an overlay and removed, because it only hides the basemap's land.
- Layer interleaving. CloudTAK stacks whole overlays rather than mixing layers from different
  sources, so a few layers sit slightly differently.
- Label font. Labels use `Open Sans Bold` instead of Noto Sans.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Console shows `GET /api/iconset/freenauticalchart/icon/... 404` and `Iconset icon not found locally or remotely` | The running build does not include the sprite change. Images are being looked up as CloudTAK iconsets. Redeploy a build that includes the `map.ts` and `icons.ts` changes, then hard-reload so a service worker does not serve the old bundle. |
| Console shows `Content Security Policy` errors for `tiles.openwaters.io/seamap/sprites/...`, and buoys, lights and other point symbols are missing while lines and areas draw | The sprite is blocked. Add `https://tiles.openwaters.io` to `CLOUDTAK_TILE_ORIGINS`, restart the API tasks, and hard-reload. |
| Depth numbers and contours are far denser than the Open Waters viewer, dashed boundary lines look too thick, or extra place labels appear | Tile Size is still 256 (the form default). Edit the overlay in **Admin > Overlays**, set Tile Size to `512` and save. Do this for both Seamap and Seascape. |
| Nothing draws and the overlay shows an error | The URL must contain `{z}/{x}/{y}` and end in `.pbf`. Check that Type is `vector` and Format is `mvt`. |
| Layers draw but labels are missing | Labels use `Open Sans Bold`. Check that fonts load in the Network tab. |
| Saving the styles fails with a validation error | The pasted JSON is incomplete or not an array. Paste the whole file. |
| The sea is not shaded as in the viewer | Expected. Depth shading from the DEM is not included, see [Why these are not a plain "import a style URL"](#why-these-are-not-a-plain-import-a-style-url). |

## Updating the styles

Open Waters updates its styles and tiles over time (the TileJSON description carries the data
date, for example `Open Waters Seamap 2026-10-26`). The style files here are a snapshot. To
refresh them, fetch `https://tiles.openwaters.io/seamap/style.json` and repeat the reduction
described above:

1. Keep the layers whose `source` is `seamap` for Seamap (leaving out the `land_area` fill) and
   the layers whose `source` is `seascape-vector` for Seascape.
2. Set `source` to a placeholder name.
3. Replace label fonts with `Open Sans Bold`.
4. Validate with the same style validator the API uses (`BasemapProtocol.isValidStyle` in
   `api/stateless/lib/interface-basemap.ts`).
5. Paste the result into **Admin > Overlays** again.

If a new version of the style adds a second sprite or a source that is not one of these two,
check whether it needs another sprite registered in `app/src/stores/map.ts`.

## Sources and licences

- Seamap: <https://openwaters.io/charts/seamap>, tiles, styles and sprites CC BY 4.0, data derived from
  OpenStreetMap contributors (ODbL).
- Seascape: <https://openwaters.io/charts/seascape>, see the licence section on that page.
- Fork implementation notes: [`fork/FORK-DELTA.md`](fork/FORK-DELTA.md), section "TileJSON, sprites and CSP".
