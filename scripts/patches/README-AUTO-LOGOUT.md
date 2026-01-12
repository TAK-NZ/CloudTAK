# Auto-Logout on Connection Error Patch

## Overview
This patch adds automatic logout when the TAK server connection fails during initialization, preventing users from seeing cryptic "other side closed" errors.

## Problem
When returning to CloudTAK after a period of inactivity, users would encounter:
- Error: "other side closed" displayed in console
- Application stuck in error state
- Repeated page reloads showing same error
- Manual navigation to `/api/logout` required to recover

This occurs when:
- TAK client certificate has expired
- Session has been invalidated
- TAK server connection is no longer valid
- Authentication has failed

## Solution
Wraps the `atlas.init()` method in a try-catch block that:
- Detects connection errors ("other side closed", 401, 403)
- Automatically redirects to `/api/logout`
- Clears session and forces re-authentication
- Provides better UX than cryptic error messages

## Changes
- Adds error handling to `atlas.init()` in `api/web/src/workers/atlas.ts`
- Catches errors during profile init, connection, database, and team initialization
- Redirects to logout on authentication/connection failures
- Re-throws other errors for proper debugging

## Files Modified
- `api/web/src/workers/atlas.ts`

## Testing
1. **Expired certificate**: Wait for certificate to expire, reload page
2. **Invalid session**: Clear backend session, reload page
3. **TAK server down**: Stop TAK server, reload page
4. **Normal operation**: Verify normal login/logout still works

## User Experience
**Before**: 
```
Error: other side closed
[User must manually navigate to /api/logout]
```

**After**:
```
[Automatic redirect to logout]
[User is prompted to log in again]
```

## Related Issues
- Fixes "other side closed" error requiring manual logout
- Improves session expiration handling
- Better UX for certificate expiration
- Complements websocket reconnection limits (patch 048)

## Dependencies
- Works with existing OIDC authentication flow
- Compatible with certificate renewal system
- No new dependencies required
