# OIDC Login and WebSocket Connection Fixes

## Summary
This document describes the balanced approach fixes implemented to address page reload issues after OIDC login and WebSocket connection failures.

## Issues Addressed

### Issue 1: Page Reload After OIDC Login
**Symptom**: After successful OIDC login, the map loads briefly then CloudTAK reloads.

**Root Cause**: Race condition between token storage, authentication verification, and route navigation. The router navigates immediately while the parent component is still verifying authentication, causing a reload when auth state settles.

**Fix**: Added 200ms delay between token storage and navigation to allow auth state to settle.

### Issue 2: WebSocket Connection Failures
**Symptom**: WebSocket connection closes with "other side closing connection" error. Only recoverable by clearing all site data.

**Root Cause**: Infinite reconnection loop when authentication fails. The WebSocket immediately reconnects with the same invalid credentials, creating a stuck state.

**Fix**: Implemented reconnection limits with exponential backoff (max 5 attempts over 25 seconds).

### Issue 3: Stale Cookie State
**Symptom**: Inconsistent authentication state after logout, requiring manual cookie clearing.

**Root Cause**: ALB OIDC uses cookie sharding (up to 4 cookies), and the base cookie wasn't being cleared. Browser caching could also preserve stale cookies.

**Fix**: Added base cookie clearing and cache control headers to logout endpoint.

## Patches Modified/Created

### Modified: `016-oidc-login-component.patch`
**File**: `api/web/src/components/Login.vue`

**Changes**:
- Added `loading.value = true` when processing OIDC token
- Wrapped navigation in `setTimeout()` with 200ms delay
- Allows auth state to settle before navigation

**Code**:
```typescript
if (route.query.token) {
    loading.value = true;
    localStorage.token = String(route.query.token);
    emit('login');
    // Small delay to let auth state settle before navigation
    setTimeout(() => {
        const redirect = route.query.redirect || '/';
        router.replace(String(redirect));
    }, 200);
    return;
}
```

**Risk**: VERY LOW - Only adds delay, doesn't change logic
**Testing**: Test OIDC login flow, verify no reload

---

### Modified: `013-oidc-login-route.patch`
**File**: `api/routes/login.ts`

**Changes**:
- Added base cookie clearing (without shard number)
- Added cache control headers to prevent cookie caching
- Ensures all cookie variations are cleared on logout

**Code**:
```typescript
// Also clear the base cookie (without shard number)
res.cookie(cookieName, '', cookieOptions);

// Add cache control headers to prevent caching
res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
res.setHeader('Pragma', 'no-cache');
res.setHeader('Expires', '0');
```

**Risk**: VERY LOW - Only adds more cookie clearing
**Testing**: Test logout flow, verify cookies cleared

---

### Created: `048-websocket-reconnection-limit.patch`
**File**: `api/web/src/workers/atlas-connection.ts`

**Changes**:
- Added `reconnectAttempts` counter (tracks retry attempts)
- Added `maxReconnectAttempts` limit (set to 5)
- Implemented exponential backoff: 1s, 2s, 4s, 8s, 10s
- Resets counter on successful connection
- Logs reconnection attempts for debugging
- Shows error message when max attempts reached

**Code**:
```typescript
// In constructor
this.reconnectAttempts = 0;
this.maxReconnectAttempts = 5;

// In open handler
this.reconnectAttempts = 0;  // Reset on success

// In close handler
if (!this.isDestroyed && this.reconnectAttempts < this.maxReconnectAttempts) {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
    console.log(`WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
        if (!this.isDestroyed) {
            this.connect(connection);
        }
    }, delay);
} else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
    console.error('WebSocket: Max reconnection attempts reached. Please refresh the page.');
}
```

**Risk**: LOW - Doesn't change detection logic, only limits retries
**Testing**: 
- Test normal reconnection (network drop)
- Test auth failure (expired token)
- Test server restart

---

## Reconnection Backoff Schedule

| Attempt | Delay | Cumulative Time |
|---------|-------|-----------------|
| 1       | 1s    | 1s              |
| 2       | 2s    | 3s              |
| 3       | 4s    | 7s              |
| 4       | 8s    | 15s             |
| 5       | 10s   | 25s             |

After 25 seconds total, connection gives up and user must refresh page.

## Deployment

The patches are automatically applied during the build process via `scripts/apply-patches.sh`.

### Verify Patches Applied
```bash
cd /home/ubuntu/GitHub/TAK-NZ/CloudTAK
./scripts/apply-patches.sh
```

### Build and Deploy
```bash
cd cdk
npm run deploy:dev  # or deploy:prod
```

## Testing Checklist

### OIDC Login Flow
- [ ] Login with SSO button
- [ ] Verify no page reload after login
- [ ] Verify map loads smoothly
- [ ] Check browser console for errors

### WebSocket Connection
- [ ] Normal operation - verify connection established
- [ ] Disconnect network briefly - verify reconnection works
- [ ] Use expired token - verify stops after 5 attempts
- [ ] Check console logs show reconnection attempts

### Logout Flow
- [ ] Logout from CloudTAK
- [ ] Verify redirect to Authentik
- [ ] Verify all cookies cleared (check browser dev tools)
- [ ] Login again - verify clean state

### Edge Cases
- [ ] Server restart during active session
- [ ] Token expiration during active session
- [ ] Multiple browser tabs open
- [ ] Mobile browser (cookie size limits)

## Rollback

If issues occur, revert the patches:

```bash
cd /home/ubuntu/GitHub/TAK-NZ/CloudTAK

# Revert Login.vue changes
git checkout api/web/src/components/Login.vue

# Revert login.ts changes
git checkout api/routes/login.ts

# Revert atlas-connection.ts changes
git checkout api/web/src/workers/atlas-connection.ts

# Rebuild
cd cdk && npm run deploy:dev
```

## Monitoring

### Browser Console Logs
Look for these messages:

**Success**:
```
WebSocket reconnecting in 1000ms (attempt 1/5)
WebSocket reconnecting in 2000ms (attempt 2/5)
```

**Failure**:
```
WebSocket: Max reconnection attempts reached. Please refresh the page.
```

### CloudWatch Logs
Monitor CloudTAK API logs for:
- OIDC login completions
- Certificate enrollment timing
- WebSocket connection attempts

## Known Limitations

1. **No automatic recovery from max attempts**: User must manually refresh page after 5 failed reconnection attempts. This is intentional to prevent infinite loops.

2. **200ms delay on login**: Adds slight delay to login flow, but prevents reload issue. This is a reasonable tradeoff.

3. **No auth failure detection**: The WebSocket doesn't distinguish between network failures and auth failures. Both are treated the same (retry with backoff). This is acceptable for the balanced approach.

## Future Enhancements

If these fixes work well, consider:
- Add explicit auth failure detection in WebSocket
- Add "Reconnect" button in UI when max attempts reached
- Implement token refresh before WebSocket connection
- Add connection health indicator in UI

## Related Documentation
- [OIDC Authentication Guide](../../docs/OIDC_AUTHENTICATION.md)
- [OIDC Implementation Summary](../../docs/OIDC_IMPLEMENTATION_SUMMARY.md)
- [Deployment Guide](../../docs/DEPLOYMENT_GUIDE.md)
