# Fix: Sprite Icon Filenames with Dots

## Problem
KMZ files with icons containing dots in their filename (e.g., `INF.01.FireStation.png`) fail to load because the sprite path processing logic incorrectly handles filenames with multiple dots.

## Root Cause
The database stores icon paths WITHOUT the file extension (e.g., `INF.01.FireStation`). The sprite generation code tries to ensure paths end with `.png`, but uses incorrect regex logic:

```typescript
// WRONG: Replaces from FIRST dot
path = path.replace(/\..*?$/, '.png');
// Result: INF.01.FireStation -> INF.png
```

Additionally, the sprite key generation uses an incorrect regex:
```typescript
// WRONG: Missing escape and anchor
coords[key.replace(/.png/, '')] = {
```

## Solution
**File**: `api/lib/sprites.ts`

1. **Simplify path processing**: Since database stores paths without extensions, just append `.png`
2. **Fix sprite key regex**: Escape dot and anchor to end of string

## Changes
- Line 123-130: Simplify icon path processing to just append `.png` if missing
- Line 135: Fix regex to properly remove `.png` extension: `/.png/` → `/\.png$/`

## Impact
- Icons with dots in filenames now load correctly
- Sprite JSON creates correct keys (e.g., `INF.01.FireStation` instead of `INF`)
- MapLibre can find and display icons properly

## Testing
1. Import KMZ with icon named `INF.01.FireStation.png`
2. Verify sprite JSON contains key `INF.01.FireStation`
3. Verify icons display on map without errors

## Related
- Patch: `044-fix-sprite-icon-dots-filename.patch`
