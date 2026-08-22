# Fix: Idempotent Overlay Creation

> **Historical patch numbers.** The `NNN-name.patch` identifiers used below refer
> to a patch set that was deleted at v13.70.0 — only 8 of its 45 files still
> matched the tree, and 19 pointed at paths upstream had moved. They are kept here
> purely as labels for the work described. The code itself is the source of truth;
> [`FORK-DELTA.md`](FORK-DELTA.md) is the current index of what differs and why.


## Problem
When users attempt to add a PMTiles file that's already in their overlays (but hidden), the application throws a database constraint error:

```
Error: Key (username, url)=(user@example.com, /api/profile/asset/xxx.pmtiles/tile) already exists.
```

This forces users to manually unhide overlays from the overlays panel instead of simply clicking to re-add them.

## Solution
Make overlay creation idempotent by:
1. **Backend**: Check for existing overlays before insert and unhide if found
2. **Frontend**: Check if map sources exist before adding them

## Changes

### Backend (`api/stateless/routes/profile-overlays.ts`)
- Move URL normalization before duplicate check
- Add duplicate detection query before insert
- Return existing overlay with `visible: true` if duplicate found
- Remove redundant URL normalization
- Delete associated iconset when deleting overlay

### Frontend (`api/web/src/base/overlay.ts`)
- Add `getSource()` check before `addSource()` for raster overlays
- Add `getSource()` check before `addSource()` for vector overlays
- Prevents "Source already exists" error

## Benefits
- ✨ No error messages when re-adding overlays
- 🔄 Idempotent API - same operation can be repeated safely
- 🎯 Intuitive behavior - "add overlay" works whether it exists or not
- 🔗 Consistent with hide/show pattern

## Testing
1. Add PMTiles file to overlays
2. Hide the overlay
3. Click to add the same PMTiles file again
4. Verify overlay becomes visible without errors
5. Verify no duplicate sources in map
6. Verify database has only one overlay record

## Related
- Patch: `045-idempotent-overlay-creation-backend.patch`
- Patch: `046-idempotent-overlay-creation-frontend.patch`
