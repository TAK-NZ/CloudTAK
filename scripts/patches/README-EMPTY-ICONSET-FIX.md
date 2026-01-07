# Fix: Empty Iconset Sprite Error

## Problem

When importing a KMZ file with no custom icons, CloudTAK creates an iconset entry but fails to generate spritesheet data. The sprite endpoints return HTTP 400 with "Request regeneration of Iconset Spritesheet", causing MapLibre to fail loading ALL sprites, resulting in no icons being displayed on the map.

## Solution

This patch modifies the sprite endpoints to return empty but valid sprites instead of 400 errors:

- **sprite.json endpoint**: Returns empty JSON object `{}` instead of 400
- **sprite.png endpoint**: Returns 1x1 transparent PNG instead of 400

This prevents the cascading failure where one bad sprite breaks all icon rendering.

## Files Modified

- `api/routes/icons.ts` - Lines ~609 and ~641

## Changes

### Before
```typescript
if (iconset.spritesheet_data) {
    res.send(Buffer.from(iconset.spritesheet_data, 'base64'));
} else {
    throw new Err(400, null, 'Request regeneration of Iconset Spritesheet');
}
```

### After
```typescript
if (iconset.spritesheet_data) {
    res.send(Buffer.from(iconset.spritesheet_data, 'base64'));
} else {
    // Return empty 1x1 transparent PNG instead of error
    console.warn(`Iconset ${req.params.iconset} has no spritesheet_data - returning empty sprite`);
    const emptyPNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    res.send(Buffer.from(emptyPNG, 'base64'));
}
```

## Benefits

1. **Prevents cascading failure** - One empty iconset no longer breaks all icons
2. **Graceful degradation** - Map continues to work with other valid iconsets
3. **Logging** - Console warnings help identify problematic iconsets
4. **No data changes** - Doesn't require database modifications
5. **Backward compatible** - Works with existing iconsets

## Upstream Status

This is a temporary fix until upstream resolves the issue. Bug reported at:
https://github.com/dfpc-coe/CloudTAK/issues/[NUMBER]

## Testing

1. Import a KMZ with no custom icons
2. Verify iconset is created in database with NULL spritesheet_data
3. Load the map
4. Verify icons from other iconsets display correctly
5. Check console for warning: "Iconset X has no spritesheet_data - returning empty sprite"

## Cleanup

Once upstream fixes this issue properly (by not creating empty iconsets), this patch can be removed.

## Related Patches

- None - This is a standalone fix for icon rendering
