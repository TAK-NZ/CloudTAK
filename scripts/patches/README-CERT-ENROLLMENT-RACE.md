# Fix Certificate Enrollment Race Condition

**Patch**: `052-fix-cert-enrollment-race-condition.patch`

## Problem

When OIDC users logged in with both attribute sync and certificate enrollment enabled, a race condition caused certificates to be lost:

1. First database commit: Saved user attributes (takCallsign, takColor)
2. Second database commit: Saved certificate **but overwrote the first commit**
3. Result: Attributes were saved, but certificate was lost

This caused the "Atlas initialization failed: Error: other side closed" error because users had no valid certificate for WebSocket connections.

## Root Cause

The code performed two separate database commits:

```typescript
// COMMIT 1: Save attributes
await config.models.Profile.commit(auth.email, {
    tak_callsign: userAttrs.takCallsign,
    tak_remarks: userAttrs.takCallsign,
    tak_group: userAttrs.takColor
});

// COMMIT 2: Save certificate (overwrites COMMIT 1!)
await config.models.Profile.commit(auth.email, {
    auth: certs
});
```

The second commit didn't include the attributes from the first commit, causing data loss.

## Solution

Combine both updates into a single database commit:

```typescript
const updates: any = {};

// Collect attribute updates
if (userAttrs.takCallsign) {
    updates.tak_callsign = userAttrs.takCallsign;
    updates.tak_remarks = userAttrs.takCallsign;
}
if (userAttrs.takColor) updates.tak_group = userAttrs.takColor;

// Collect certificate update
if (needsCertificate) {
    const certs = await api.Credentials.generate();
    updates.auth = certs;
}

// Single commit with all updates
await config.models.Profile.commit(auth.email, updates);
```

## Impact

- **Before**: Certificate enrollment succeeded but data was lost in database
- **After**: Both attributes and certificate are saved atomically
- **User Experience**: Users can now login successfully without WebSocket errors

## Testing

1. Login via OIDC with a new user
2. Check database for certificate:
   ```sql
   SELECT username, LENGTH(auth->>'cert') as cert_length 
   FROM profile WHERE username = 'user@example.com';
   ```
3. Verify `cert_length > 0`
4. Verify no "other side closed" errors in browser console

## Related Issues

- Fixes "Atlas initialization failed: Error: other side closed"
- Fixes certificate enrollment appearing successful in logs but not persisting
- Related to patches: 013, 021, 051
