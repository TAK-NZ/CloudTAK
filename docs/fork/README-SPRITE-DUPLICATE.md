# Fix: Sprite Duplicate Loading and Endpoint Typo

> **Historical patch numbers.** The `NNN-name.patch` identifiers used below refer
> to a patch set that was deleted at v13.70.0 — only 8 of its 45 files still
> matched the tree, and 19 pointed at paths upstream had moved. They are kept here
> purely as labels for the work described. The code itself is the source of truth;
> [`FORK-DELTA.md`](FORK-DELTA.md) is the current index of what differs and why.


## Problem
1. **Duplicate Sprite Error**: When iconsets are loaded multiple times, MapLibre throws error about sprite already existing
2. **Endpoint Typo**: IconManager uses `/sprites` (plural) instead of `/sprite` (singular), preventing initial sprite loading

## Solution
**File**: `api/web/src/stores/modules/icons.ts`

### Fix 1: Check Before Adding Sprite
Add check using `getSprite()` to see if sprite already exists before calling `addSprite()`:

```typescript
const sprites = this.map.getSprite();
if (sprites && sprites.find((s: { id: string }) => s.id === iconset.uid)) {
    console.log(`Sprite ${iconset.uid} already loaded, skipping`);
    return;
}
```

### Fix 2: Correct Endpoint URL
Change `/sprites` to `/sprite` to match actual API endpoint:

```typescript
// WRONG
url: String(stdurl(`/api/iconset/${iconset.uid}/sprites?token=${localStorage.token}`))

// CORRECT
url: String(stdurl(`/api/iconset/${iconset.uid}/sprite?token=${localStorage.token}`))
```

## Impact
- No more duplicate sprite errors when iconsets are reloaded
- Initial sprite loading works correctly for all iconsets
- Icons display properly on map initialization

## Testing
1. Load a KMZ with custom icons
2. Reload the page
3. Verify no duplicate sprite errors in console
4. Verify icons load and display correctly

## Related
- Patch: `047-fix-sprite-duplicate-and-endpoint.patch`
