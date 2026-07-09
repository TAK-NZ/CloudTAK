# Bug: KMZ/KML icons are unselectable when obscured by a CoT polygon

## Description

KMZ/KML imports are rendered as overlays, which sit below the CoT feature layer in the MapLibre layer stack. When a CoT polygon (e.g. a drawn area, geofence, or shape shared via ATAK) covers the same map area as a KMZ/KML point icon, the CoT polygon's fill intercepts all click/tap events at that location. The KMZ icon underneath becomes completely unselectable — the user cannot open its popup or description panel regardless of how precisely they click on it.

## Steps to Reproduce

1. Import a KMZ/KML file that contains point icons with descriptions (e.g. camera markers, POI markers).
2. Ensure a CoT polygon exists on the map that spatially overlaps one or more of those icons — this can be a drawn shape, a shared ATAK polygon, or a mission geometry.
3. Attempt to click/tap the KMZ icon underneath the polygon.

**Expected:** Clicking the icon opens its description/popup, regardless of what CoT features are layered on top.  
**Actual:** The click is consumed by the CoT polygon fill. The KMZ icon's click handler never fires.

## Root Cause

MapLibre resolves click targets by hit-testing layers in reverse paint order — the topmost rendered layer wins. CoT features (polygons, lines, points) are added to the map after overlay layers, placing them higher in the stack. A CoT polygon's fill layer has a non-zero interactive hit area covering its entire extent, so any click within that area is attributed to the polygon rather than to any overlay icon underneath it.

This is not a MapLibre limitation per se — MapLibre's `queryRenderedFeatures` can return features from multiple layers at a given point. The issue is that CloudTAK's click handler stops at the first match rather than checking all features at the click location across all layers.

## Impact

- Any KMZ/KML point icon that falls within the bounds of a CoT polygon becomes inaccessible to the user.
- This is particularly problematic for operational use cases where KMZ overlays (e.g. infrastructure markers, camera feeds, sensor locations) are combined with area-of-operations polygons drawn by TAK users.
- The user has no visual indication that a selectable feature exists under the polygon — there is no z-order affordance in the UI.

## Recommended Fix

In the map click handler, use `map.queryRenderedFeatures(point, { layers: [...all interactive layers...] })` to collect **all** features at the click location across all layers rather than relying on the first match from the event target. Then apply a priority order:

1. Point/icon features (CoT or overlay) — highest priority since they are smallest hit targets.
2. Line features.
3. Polygon features — lowest priority since they cover the largest area.

Within each tier, prefer the topmost layer. This ensures a KMZ icon obscured by a polygon fill is still selectable, matching the behaviour of ATAK and Google Earth where point features always take click precedence over area features regardless of render order.

A simpler short-term mitigation is to set `fill-opacity: 0` (or very low) on CoT polygon layers while keeping `fill-outline-color` visible, so the polygon's hit area is reduced to its outline only. However this changes the visual appearance and is not a correct fix.
