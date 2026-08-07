# OIDC Authentication Patches

This directory contains Git patches for the OIDC authentication implementation. These patches should be applied after syncing with upstream CloudTAK to restore TAK.NZ-specific OIDC functionality.

**Architecture note (Aug 2026):** OIDC authentication moved from an ALB-based
`authenticateOidc` listener action (ALB handled the Authorization Code
exchange and injected the result as request headers/cookies) to an in-app
Authorization Code flow handled entirely by CloudTAK's own API
(`GET /api/login/oidc` redirects to the IdP, `GET /api/login/oidc/callback`
performs the code exchange, userinfo fetch, role sync, and cert enrollment).
The ALB is now a plain TLS pass-through with no OIDC involvement. This means
most of the descriptions below (ALB headers, ES256 signature verification of
ALB-issued tokens, `?token=` query-string handoff) describe the *previous*
implementation and are kept here for historical context on what changed and
why — see each patch file's actual diff for the current behavior, and
`PATCH_AUDIT.md` for up-to-date one-line summaries.

## Patches

### Backend (API)

1. **011-oidc-auth-lib.patch** - `api/lib/auth.ts`
   - `isOidcEnabled()`/`isOidcForced()` helpers, feature-flagged via `OIDC_ENABLED`/`OIDC_FORCED` env vars
   - ALB JWT header parsing/ES256 verification (`oidcParser()`) removed — no longer needed now that CloudTAK's own API performs the Authorization Code exchange directly

2. **013-oidc-login-route.patch** - `api/routes/login.ts`
   - `GET /api/login/oidc` — redirects to the IdP's authorization endpoint
   - `GET /api/login/oidc/callback` — exchanges the code, fetches userinfo, syncs roles from the `groups` claim, enrolls a TAK client cert (see patch 026), syncs Authentik attributes, and hands the session to the frontend via a `/login#sso=<base64url payload>` URL fragment (not a query string, to keep the session token out of server access logs and browser history)
   - `OIDC_FORCED` system-admin bypass: blocks non-admin users from `POST /api/login` with a 403 when SSO is enforced; system admins can still log in locally via `/login?local=true`

3. **014-oidc-server-route.patch** - `api/routes/server.ts`
   - Adds GET `/api/server/oidc` public endpoint
   - Returns `oidc_enabled` and `oidc_forced`

4. **015-oidc-types.patch** - `api/lib/types.ts`
   - Adds `oidc_enabled: Type.Boolean()` to ServerResponse type

### Frontend

5. **016-oidc-login-component.patch** - `api/web/src/components/Login.vue`
   - "Login with SSO" button, redirects to `/api/login/oidc`
   - `consumeSSOLogin()` parses the session out of the `/login#sso=<payload>` URL fragment set by the callback route above (previously a `?token=` query param)
   - `OIDC_FORCED` handling: auto-redirects to SSO unless `?local=true` is present; dynamic loading message during the redirect/completion window to avoid a login-form flash

6. **018-oidc-app-logout.patch** - `api/web/src/App.vue`
   - Updates logout function to redirect to `/api/logout`
   - Clears localStorage token before redirect

## Applying Patches

After syncing with upstream, apply patches in order:

```bash
# Navigate to CloudTAK root
cd /home/ubuntu/GitHub/TAK-NZ/CloudTAK

# Apply all patches in order
for patch in scripts/patches/01*-oidc-*.patch; do
    echo "Applying $patch..."
    git apply "$patch" || echo "Failed to apply $patch"
done
```

## Verifying Patches

After applying patches, verify:

```bash
# Check that files were modified
git status

# Review changes
git diff

# Test compilation
cd api && npm run build
cd ../api/web && npm run build
```

## Dependencies

The OIDC implementation requires these npm packages (should already be in package.json):

### Backend (`api/package.json`)
- `@tak-ps/node-tak` - TAK Server API client
- `@aws-sdk/client-secrets-manager` - AWS Secrets Manager
- No HTTP client dependency needed — the Authorization Code exchange, userinfo fetch, and all Authentik API calls use the native `fetch` global (Node 24+). The `axios` dependency previously required here has been removed.

### Frontend (`api/web/package.json`)
- `@tabler/icons-vue` - Icon library (IconKey)

## Environment Variables

After applying patches, ensure these environment variables are set (handled by CDK — see `cdk/lib/constructs/cloudtak-api.ts`):

- `OIDC_ENABLED="true"` - Enable OIDC feature
- `OIDC_FORCED="true"` - Enforce SSO login (blocks non-admin local login)
- `OIDC_DISCOVERY_URL="https://account.test.tak.nz/application/o/cloudtak/.well-known/openid-configuration"` - OIDC discovery document URL
- `OIDC_CLIENT_ID="..."` - OIDC client ID
- `OIDC_CLIENT_SECRET` - resolved from Secrets Manager by the ECS execution role, not passed as plaintext
- `OIDC_SCOPES="openid profile email groups"` - requested scopes
- `AUTHENTIK_URL="https://account.test.tak.nz"` - Authentik instance URL
- `AUTHENTIK_API_TOKEN_SECRET_ARN="arn:aws:..."` - Secret ARN for Authentik API token

## Related Files (Not Patched)

These files are TAK.NZ-specific and won't conflict with upstream:

- `cdk/lib/stack-config.ts` - Configuration types
- `cdk/lib/constructs/load-balancer.ts` - ALB OIDC listener
- `cdk/lib/constructs/cloudtak-api.ts` - Environment variables
- `cdk/lib/cloudtak-stack.ts` - OIDC setup integration
- `cdk/lib/constructs/cloudtak-oidc-setup.ts` - Authentik automation
- `cdk/src/cloudtak-oidc-setup/` - Lambda function
- `docs/OIDC_AUTHENTICATION.md` - Documentation

## Troubleshooting

### Patch Fails to Apply

If a patch fails due to upstream changes:

1. Check the rejected hunks in `.rej` files
2. Manually apply the changes
3. Regenerate the patch (see `PATCH_AUDIT.md` for the exact baseline commit to diff against):
   ```bash
   git diff <baseline-commit> HEAD -- <file> > scripts/patches/0XX-<name>.patch
   ```

### Merge Conflicts

If upstream modified the same code:

1. Apply patch with 3-way merge:
   ```bash
   git apply --3way scripts/patches/0XX-<name>.patch
   ```
2. Resolve conflicts manually
3. Update patch if needed

> **Note:** Patches 020–032 (nginx buffer/CSP, Authentik provider methods, agency/machine-user
> management, connection cleanup, etc.) are documented in `PATCH_AUDIT.md`, which is the
> single up-to-date source of truth for every patch's current status and description. This
> file previously duplicated those descriptions with stale, ALB-era wording; see
> `PATCH_AUDIT.md` instead of relying on anything below this point for patches outside the
> OIDC-specific ones listed above.

## Documentation

See `docs/OIDC_AUTHENTICATION.md` for complete implementation details and `UPSTREAM-FEATURE-REQUEST.md` for the feature request to submit upstream.
