# OIDC Authentication

> **Historical patch numbers.** The `NNN-name.patch` identifiers used below refer
> to a patch set that was deleted at v13.70.0 — only 8 of its 45 files still
> matched the tree, and 19 pointed at paths upstream had moved. They are kept here
> purely as labels for the work described. The code itself is the source of truth;
> [`FORK-DELTA.md`](FORK-DELTA.md) is the current index of what differs and why.


This document describes TAK-NZ's OIDC authentication implementation and the files it spans. Nothing here needs applying after an upstream sync — git carries these changes forward through the `vendor/upstream` merge.

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
`FORK-DELTA.md` for up-to-date one-line summaries.

## Patches

### Backend (API)

1. `api/common/auth.ts`
   - `isOidcEnabled()`/`isOidcForced()` helpers, feature-flagged via `OIDC_ENABLED`/`OIDC_FORCED` env vars
   - ALB JWT header parsing/ES256 verification (`oidcParser()`) removed — no longer needed now that CloudTAK's own API performs the Authorization Code exchange directly

2. `api/stateless/routes/login.ts`, `api/stateless/lib/oidc.ts`
   - `GET /api/login/oidc` — redirects to the IdP's authorization endpoint
   - `GET /api/login/oidc/callback` — exchanges the code, fetches userinfo, identifies the user by the
     `preferred_username` claim (falling back to `email`, lowercased, if `preferred_username` is absent
     — this lets users without an email attribute in Authentik log in), syncs roles from the `groups`
     claim, enrolls a TAK client cert (see `AuthentikProvider.enrollUserCertificate()`), syncs Authentik
     attributes, and hands the session to the frontend via a `/login#sso=<base64url payload>` URL
     fragment (not a query string, to keep the session token out of server access logs and browser
     history)
   - `OIDC_FORCED` system-admin bypass: blocks non-admin users from `POST /api/login` with a 403 when SSO is enforced; system admins can still log in locally via `/login?local=true`

3. `api/stateless/routes/server.ts`
   - Adds GET `/api/server/oidc` public endpoint
   - Returns `oidc_enabled` and `oidc_forced`

4. `api/common/types.ts`
   - Adds `oidc_enabled: Type.Boolean()` to ServerResponse type

### Frontend

5. `api/web/src/components/Login.vue`
   - "Login with SSO" button, redirects to `/api/login/oidc`
   - `consumeSSOLogin()` parses the session out of the `/login#sso=<payload>` URL fragment set by the callback route above (previously a `?token=` query param)
   - `OIDC_FORCED` handling: auto-redirects to SSO unless `?local=true` is present; dynamic loading message during the redirect/completion window to avoid a login-form flash

6. `api/web/src/App.vue`, `api/web/src/stores/app.ts`
   - Updates logout function to redirect to `/api/logout`
   - Clears localStorage token before redirect

## Applying Patches

> **Obsolete section.** Upstream syncs are a 3-way merge via the
> `vendor/upstream` branch, so nothing is re-applied after a sync — git carries
> the OIDC changes forward. There is no patch set to apply. See
> [`docs/UPSTREAM-SYNC.md`](../UPSTREAM-SYNC.md) for the runbook and
> [`FORK-DELTA.md`](FORK-DELTA.md) for what the OIDC changes are and why.
>
> To see the current OIDC delta against upstream:
>
> ```bash
> git diff vendor/upstream...HEAD -- \
>     api/stateless/routes/login.ts api/stateless/lib/oidc.ts \
>     api/common/auth.ts api/web/src/components/Login.vue
> ```

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
- `cdk/lib/constructs/cloudtak-api.ts` - Environment variables
- `cdk/lib/cloudtak-stack.ts` - OIDC setup integration
- `cdk/lib/constructs/cloudtak-oidc-setup.ts` - Authentik automation
- `cdk/src/cloudtak-oidc-setup/` - Lambda function
- `docs/OIDC_AUTHENTICATION.md` - Documentation

## Troubleshooting

### Merge Conflicts

If upstream modified the same code, `scripts/sync-upstream.sh` leaves the
conflict staged for you to resolve in place. Read this file and
[`FORK-DELTA.md`](FORK-DELTA.md) to understand what the TAK-NZ side was trying to
achieve, then resolve. There is nothing to regenerate afterwards — the resolved
file *is* the record.

> **Note:** the adjacent concerns — nginx CSP, Authentik provider methods,
> agency and machine-user management, connection cleanup — are described in
> [`FORK-DELTA.md`](FORK-DELTA.md), which is the up-to-date source of truth.
> This file previously duplicated those descriptions with stale, ALB-era wording,
> so prefer `FORK-DELTA.md` over anything below this point that is not
> OIDC-specific.

## Documentation

See `docs/OIDC_AUTHENTICATION.md` for implementation details.

**Upstream status (Aug 2026):** the ALB OIDC feature request
([#1171](https://github.com/dfpc-coe/CloudTAK/issues/1171)) was **closed by us as abandoned** — we
replaced ALB OIDC with an in-app Authorization Code flow (patches 013/016) after hitting ES256/P1363
JWT verification friction, ALB session-cookie sharding overflowing nginx header buffers, no IdP logout
endpoint, and an inability to control our own login ordering. The local `UPSTREAM-FEATURE-REQUEST.md`
that backed it has been deleted.

Live upstream OIDC tracking is [#661 OAuth 2.0 / OIDC support (Client aka Relying Party)](https://github.com/dfpc-coe/CloudTAK/issues/661)
(`Priority: High`), which matches the in-app approach we actually shipped. Authentik-specific
integration is [#1180](https://github.com/dfpc-coe/CloudTAK/issues/1180).
