# Tab Visibility Reconnection - Implementation Summary

## Changes Made

### 1. `/api/web/src/workers/atlas-connection.ts`
Added `reconnect()` method to force WebSocket reconnection:
- Resets reconnection attempt counter to 0
- Closes existing WebSocket connection
- Initiates fresh connection attempt
- Bypasses the 5-attempt limit that could leave connection permanently dead

### 2. `/api/web/src/stores/map.ts`
Added Page Visibility API listener in `init()` method:
- Listens for `visibilitychange` events
- When tab becomes visible (`!document.hidden`):
  - Checks if WebSocket is still open
  - If closed, forces reconnection with stored username
  - Refreshes CoT data via `updateCOT()`
- Ensures fresh data when user returns to tab

### 3. `/api/web/src/workers/atlas.ts`
Store username for reconnection:
- Added `username: string` property to Atlas class
- Store username during initialization: `this.username = await this.profile.init()`
- Enables reconnection without re-initializing entire profile

## Files Created

### `/scripts/patches/050-tab-visibility-reconnect.patch`
Patch file for upstream contribution to dfpc-coe/CloudTAK repository.

### `/FEATURE_REQUEST_TAB_VISIBILITY.md`
Comprehensive feature request document including:
- Problem statement and current behavior
- Proposed solution with code examples
- Benefits and technical details
- Testing scenarios
- References to browser APIs and best practices

## How It Works

```
User switches away from tab
    ↓
Browser throttles tab (after ~5 minutes)
    ↓
WebSocket connection closes
    ↓
Auto-reconnect attempts fail (throttled setTimeout)
    ↓
User returns to tab
    ↓
visibilitychange event fires
    ↓
Check: Is WebSocket open?
    ↓ (No)
Reset reconnect counter & force reconnect
    ↓
Refresh CoT data
    ↓
User sees current data ✓
```

## Testing

To test the implementation:

1. Open CloudTAK in browser tab
2. Switch to another tab for 5+ minutes
3. Return to CloudTAK tab
4. Check browser console for: `"Tab became visible with closed connection, reconnecting..."`
5. Verify CoT icons update with current positions

## Browser Compatibility

Page Visibility API is supported in:
- Chrome 33+
- Firefox 18+
- Safari 7+
- Edge 12+
- All modern mobile browsers

## Performance Impact

- **Minimal**: Only runs when tab becomes visible
- **No polling**: Event-driven, not continuous checking
- **Lightweight**: Reuses existing WebSocket infrastructure
- **No memory leaks**: Single event listener, properly scoped

## Next Steps

1. **Test in development**: Deploy to dev environment and test tab switching
2. **Monitor logs**: Check for reconnection messages in browser console
3. **Submit upstream**: Create PR to dfpc-coe/CloudTAK with patch and feature request
4. **Document**: Update CloudTAK documentation with this behavior

## Related Changes

This feature complements the existing auto-logout on connection error feature (patch 049), providing a complete solution for connection management:
- **Patch 049**: Auto-logout when connection fails with authentication errors
- **Patch 050**: Auto-reconnect when tab becomes visible after backgrounding
