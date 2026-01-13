# Feature Request: Tab Visibility Reconnection

## Summary
Add automatic WebSocket reconnection and data refresh when browser tab becomes visible after being backgrounded.

## Problem Statement

When a CloudTAK browser tab is inactive for an extended period, browsers aggressively throttle background tabs to conserve resources. This causes:

1. **WebSocket disconnection**: The WebSocket connection to the CloudTAK server closes
2. **Stale data**: CoT icons show outdated positions or disappear entirely
3. **Failed reconnection**: The existing auto-reconnect logic (5 attempts with exponential backoff) may fail because:
   - `setTimeout` callbacks are throttled or never fire in background tabs
   - After 5 failed attempts, reconnection stops permanently
4. **Poor UX**: Users return to the tab and see stale/missing data with no indication of the problem

## Current Behavior

- WebSocket has auto-reconnect with 5 attempts and exponential backoff
- Background tab throttling prevents reliable reconnection
- Users must manually refresh the page to restore connection
- No visual indication that data is stale

## Proposed Solution

Implement the **Page Visibility API** to detect when tabs become visible and trigger reconnection:

### Implementation

**1. Add reconnect method to `atlas-connection.ts`:**
```typescript
reconnect(connection: string) {
    console.log('Forcing WebSocket reconnection...');
    this.reconnectAttempts = 0;  // Reset counter
    if (this.ws) {
        this.ws.close();
    }
    this.connect(connection);
}
```

**2. Add visibility listener in `map.ts` init():**
```typescript
document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
        const isOpen = await this.worker.conn.isOpen;
        if (!isOpen) {
            console.log('Tab became visible with closed connection, reconnecting...');
            const username = await this.worker.profile.profile.then(p => p.username);
            await this.worker.conn.reconnect(username);
        }
        await this.updateCOT();
    }
});
```

**3. Store username in `atlas.ts` for reconnection:**
```typescript
// Store username during init for later reconnection
this.username = await this.profile.init();
await this.conn.connect(this.username)
```

## Benefits

- **Seamless UX**: Automatic reconnection when user returns to tab
- **Fresh data**: CoT icons update immediately on tab visibility
- **No page reload**: Preserves map position, zoom, and overlay state
- **Lightweight**: Only reconnects if actually disconnected
- **Browser-native**: Uses standard Page Visibility API (supported in all modern browsers)

## Technical Details

### Page Visibility API
- Standard browser API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- Supported in all modern browsers (Chrome, Firefox, Safari, Edge)
- Fires `visibilitychange` event when tab visibility changes
- `document.hidden` property indicates current visibility state

### Reconnection Logic
1. Tab becomes visible → `visibilitychange` event fires
2. Check if WebSocket is open
3. If closed, reset reconnect counter and force reconnection
4. Refresh CoT data from worker database
5. User sees current data without manual intervention

### Performance Impact
- Minimal: Only runs when tab becomes visible
- No polling or continuous checks
- Reuses existing reconnection infrastructure

## Testing Scenarios

1. **Background tab for 5+ minutes**: Connection should restore on return
2. **Multiple tabs**: Each tab should independently manage its connection
3. **Network interruption**: Should work alongside existing reconnect logic
4. **Rapid tab switching**: Should not cause connection thrashing

## Alternative Approaches Considered

1. **Increase reconnect attempts**: Doesn't solve throttling issue
2. **Full page reload**: Loses user state (map position, overlays)
3. **Persistent connection**: Not possible with browser throttling
4. **WebSocket ping/pong**: Still throttled in background tabs

## Related Issues

- Browser tab throttling affects all web applications with real-time data
- Similar patterns used by Google Maps, Slack, Discord, etc.
- Standard solution in modern web applications

## Implementation Patch

See `scripts/patches/050-tab-visibility-reconnect.patch` for complete implementation.

## References

- [Page Visibility API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [Background Tab Throttling - Chrome Developers](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/)
- [WebSocket Reconnection Patterns](https://javascript.info/websocket#reconnection)
