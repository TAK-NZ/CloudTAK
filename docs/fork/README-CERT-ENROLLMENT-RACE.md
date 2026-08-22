# Fix Certificate Enrollment Race Condition

> **Historical patch numbers.** The `NNN-name.patch` identifiers used below refer
> to a patch set that was deleted at v13.70.0 — only 8 of its 45 files still
> matched the tree, and 19 pointed at paths upstream had moved. They are kept here
> purely as labels for the work described. The code itself is the source of truth;
> [`FORK-DELTA.md`](FORK-DELTA.md) is the current index of what differs and why.


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

---

# Concurrent Enrollment Request Race (Aug 2026)

**Patches**: `013-oidc-login-route.patch`, `026-authentik-provider-complete.patch`

## Problem

A user reported that a brand-new OIDC user's callsign/group/role were not pre-filled on
first login, even though the corresponding `takCallsign`/`takColor`/`takRole` attributes
genuinely existed on their Authentik account.

Production CloudWatch logs (`/aws/ecs/TAK-Demo-CloudTAK`, `tak-nz-demo` profile, `ap-southeast-2`)
showed two `GET /api/login/oidc` requests for the same user 5.6 seconds apart:

```
04:45:27  GET /api/login/oidc  ->  499  (client aborted the connection)
04:45:33  GET /api/login/oidc  ->  302  (completed, redirected with a JWT)
```

The first request kept running server-side after the client disconnected (Node does not
cancel in-flight work just because the client closed the connection) and logged:

```
TAK certificate enrolled successfully for: <user>
```

The second, concurrent request then failed inside the same code path:

```
Authentik cert/attribute sync error for <user> (continuing): PublicError: Status: 405
  at OAuthCommands.login (node_modules/@tak-ps/node-tak/lib/api/oauth.ts:54)
  at APIAuthPassword.init (node_modules/@tak-ps/node-tak/lib/auth.ts:42)
  at TAKAPI.init (node_modules/@tak-ps/node-tak/lib/api.ts:154)
  at AuthentikProvider.enrollUserCertificate (authentik-provider.ts:507)
  at login.ts:304
  status: 400, safe: 'Non-200 Response from Auth Server - Token'
```

## Root Cause

Two independent bugs compounded:

1. **`enrollUserCertificate()` is not safe against concurrent calls for the same user.**
   It sets a random temporary password on the shared Authentik user account, authenticates
   against TAK Server with it, then reverts the password in a `finally` block:

   ```typescript
   const tempPassword = crypto.randomBytes(32).toString('base64url');
   await fetch(passwordUrl, ... );          // set temp password
   const takAuth = new APIAuthPassword(username, tempPassword);
   const takApi = await TAKAPI.init(...);   // login to TAK Server with it
   ...
   finally {
       await fetch(revokeUrl, ... );        // revoke by setting yet another password
   }
   ```

   Two concurrent OIDC callbacks for the same user each mutate this one shared credential.
   If request A's TAK Server login attempt runs after request B has already overwritten
   the account's password (with B's own temp password, or B's revoke step), A's login fails
   with a stale-credential auth error from TAK Server.

2. **Cert enrollment and attribute sync shared a single try/catch in `login.ts`.**
   Cert enrollment ran first; when it threw (as in bug #1 above), the exception aborted the
   whole block, so the attribute-sync code — which reads `takCallsign`/`takColor`/`takRole`
   from Authentik and commits them via `ProfileConfig.commit()` — never executed at all. This
   is the mechanism behind the reported symptom: the callsign dialog was blank not because
   attribute sync failed to find the data, but because it never ran.

The two concurrent `/login/oidc` requests themselves stem from the browser aborting and
re-firing the OIDC callback (visible as the `499` on the first request) — most likely a
double-navigation or reload during the ALB OIDC redirect chain. The backend fix does not
address why the browser double-fires the request; it makes the backend robust to it
regardless of the cause.

## Fix

**`api/stateless/lib/authentik-provider.ts`** — wrap the set-password / TAK-login / revoke-password
sequence in `enrollUserCertificate()` in a Postgres advisory transaction lock keyed on a
hash of the username:

```typescript
async enrollUserCertificate(username: string, takServerUrl: string) {
    return this.config.pg.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(918273645, hashtext(${username}))`);
        // ... existing set-password / TAK-login / revoke-password logic, unchanged ...
    });
}
```

A real Postgres advisory lock (not an in-process mutex) is required because concurrent
requests for the same user can land on different ECS tasks behind the load balancer; an
in-memory lock would only serialize requests within a single container.

**`api/stateless/routes/login.ts`** — give cert enrollment and attribute sync independent try/catch
blocks, so a failure in one can no longer prevent the other from running:

```typescript
if (certNeedsRenewal(profile.auth?.cert)) {
    try {
        // ... enrollUserCertificate() ...
    } catch (err) {
        console.error(`Authentik cert enrollment error for ${email} (continuing):`, err);
    }
}

try {
    // ... attribute sync via authentik.login() + ProfileConfig.commit() ...
} catch (err) {
    console.error(`Authentik attribute sync error for ${email} (continuing):`, err);
}
```

## Impact

- **Before**: A concurrent duplicate OIDC callback for the same user could make cert
  enrollment fail with a stale-credential error, and that failure silently skipped
  attribute sync too — leaving a first-time user with a blank callsign/group/role dialog
  even though their Authentik attributes existed.
- **After**: Concurrent enrollment attempts for the same user serialize instead of
  corrupting each other's temporary password, and a cert enrollment failure (from this or
  any other cause) no longer blocks attribute sync from running and committing.

## Testing

1. Login via OIDC with a new user whose Authentik account has `takCallsign`/`takColor`/`takRole`
   attributes set.
2. Confirm `profile_settings` (`tak::callsign`, `tak::group`, `tak::role`) is populated even
   if the CloudTAK API logs show a `Authentik cert enrollment error for <email> (continuing)`
   line for that login.
3. To reproduce the original race under load, fire two concurrent `GET /api/login/oidc`
   requests for the same user (e.g. via two browser tabs completing the ALB OIDC redirect
   within a couple of seconds of each other) and confirm neither cert enrollment attempt
   fails with a `400`/`405` "Non-200 Response from Auth Server - Token" error.

## Related Issues

- Distinct from the DB-commit-overwrite race originally described above this section
  (patch 052, now superseded — see the note at the top of this file and in `FORK-DELTA.md`).
- Related to patches: 013, 026, 051.
