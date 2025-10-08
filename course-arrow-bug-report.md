# Bug Report: Course Arrow Rendering Failure Due to Invalid MapLibre GL JS Expression

## Summary
Course arrows for non-rotating icons fail to render due to invalid `icon-offset` expression syntax in `api/web/src/base/utils/styles.ts`. The current implementation violates MapLibre GL JS expression rules by using multiple zoom-based interpolations within a single property.

## Severity
**High** - Breaks course arrow functionality for non-rotating icons

## Environment
- **CloudTAK Version**: Latest main branch
- **MapLibre GL JS**: Current version
- **Error Location**: `api/web/src/base/utils/styles.ts` lines 170-190

## Problem Description
The course arrow layer fails to render with the following MapLibre GL JS error:

```
Error: layers.-1-course.layout.icon-offset: Only one zoom-based "step" or "interpolate" subexpression may be used in an expression.
```

This prevents course arrows from displaying when icon rotation is disabled, breaking the non-rotating icons feature.

## Root Cause
The current `icon-offset` implementation uses a `case` expression containing multiple `interpolate` expressions, which violates MapLibre GL JS expression syntax rules:

### Current Implementation (Broken)
```javascript
'icon-offset': [
    'case',
    ['has', 'icon'],
    // First interpolate expression
    [
        'interpolate',
        ['linear'],
        ['zoom'],
        8, ['literal', [0, -28]],
        12, ['literal', [0, -42]],
        16, ['literal', [0, -58]]
    ],
    // Second interpolate expression (INVALID!)
    [
        'interpolate',
        ['linear'],
        ['zoom'],
        8, ['literal', [0, -18]],
        12, ['literal', [0, -24]],
        16, ['literal', [0, -30]]
    ]
]
```

**Problem**: Multiple `interpolate` expressions within a single property are not allowed in MapLibre GL JS.

## Proposed Fix
Use a single `interpolate` expression with `case` expressions at each zoom level:

### Corrected Implementation
```javascript
'icon-offset': [
    'interpolate',
    ['linear'],
    ['zoom'],
    8, [
        'case',
        ['has', 'icon'],
        ['literal', [0, -28]], // Regular icons
        ['literal', [0, -18]]  // Dots (no icon)
    ],
    12, [
        'case',
        ['has', 'icon'],
        ['literal', [0, -42]], // Regular icons
        ['literal', [0, -24]]  // Dots (no icon)
    ],
    16, [
        'case',
        ['has', 'icon'],
        ['literal', [0, -58]], // Regular icons
        ['literal', [0, -30]]  // Dots (no icon)
    ]
]
```

## Code Changes Required

**File**: `api/web/src/base/utils/styles.ts`

**Replace lines 170-190** (approximately) in the course arrow layout:

```diff
- 'icon-offset': [
-     'case',
-     ['has', 'icon'],
-     // Regular icons - current distances
-     [
-         'interpolate',
-         ['linear'],
-         ['zoom'],
-         8, ['literal', [0, -28]],
-         12, ['literal', [0, -42]],
-         16, ['literal', [0, -58]]
-     ],
-     // Dots (no icon) - smaller distances
-     [
-         'interpolate',
-         ['linear'],
-         ['zoom'],
-         8, ['literal', [0, -18]],
-         12, ['literal', [0, -24]],
-         16, ['literal', [0, -30]]
-     ]
- ],
+ 'icon-offset': [
+     'interpolate',
+     ['linear'],
+     ['zoom'],
+     8, [
+         'case',
+         ['has', 'icon'],
+         ['literal', [0, -28]],
+         ['literal', [0, -18]]
+     ],
+     12, [
+         'case',
+         ['has', 'icon'],
+         ['literal', [0, -42]],
+         ['literal', [0, -24]]
+     ],
+     16, [
+         'case',
+         ['has', 'icon'],
+         ['literal', [0, -58]],
+         ['literal', [0, -30]]
+     ]
+ ],
```

## Impact
- **Course arrows don't display** for non-rotating icons
- **MapLibre GL JS errors** in browser console
- **Broken non-rotating icons feature** - users can't see directional indicators

## Steps to Reproduce
1. Enable non-rotating icons in user preferences (`display_icon_rotation: false`)
2. Load CoT data with course information
3. Observe browser console errors
4. Notice course arrows are not displayed on the map

## Validation
The proposed fix follows MapLibre GL JS expression syntax rules:
- **Single interpolation**: Only one `interpolate` expression per property
- **Conditional logic**: `case` expressions used within zoom levels
- **Maintains functionality**: Preserves different offsets for icons vs dots

## Additional Context
This issue was introduced when the course arrow positioning logic was modified to handle different offset distances for regular icons versus dots. The implementation attempted to use multiple interpolations which violates MapLibre GL JS expression constraints.

## References
- [MapLibre GL JS Expression Documentation](https://maplibre.org/maplibre-style-spec/expressions/)
- [Expression Syntax Rules](https://maplibre.org/maplibre-style-spec/expressions/#interpolate)