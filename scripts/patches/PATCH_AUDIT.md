# Patch Audit & Status

This document describes every patch in `scripts/patches/`, what it does, its current status, and whether it needs attention before the next upstream sync.

All patches are now **valid git diffs** generated with `git diff <v13-baseline> HEAD -- <file(s)>` and verified with `git apply --check --reverse`. Applying the reverse of a patch to the current codebase should always succeed cleanly; if it does not, the patch is stale and needs regeneration.

The v13.26.0 upstream baseline commit is **418bdc4be**.

---

## Patch Summary

| Patch | Files | What it does | Status |
|---|---|---|---|
| 000 | `api/lib/config.ts` | `CLOUDTAK_Server_*` env var seeding, `MediaSecret`/`DynamoDB`/VPC config fields, admin profile provisioning | ✅ Applied & valid |
| 001 | `api/web/src/components/CloudTAK/Map.vue` | Removes upstream `.maplibregl-ctrl-scale` CSS overrides | ✅ Applied & valid |
| 002 | 9 Vue/TS files | Replaces `IconAmbulance` with `IconReplace` across frontend | ✅ Applied & valid |
| 003 | `api/web/src/components/CloudTAK/MainMenuContents.vue` | Removes Application Switcher dropdown; logout redirects to `/api/logout` | ✅ Applied & valid |
| 004 | `api/web/src/components/ETL/Connection/ChannelInfo.vue` | Changes default `label` prop from `'Data Syncs'` to `'Missions'` | ✅ Applied & valid |
| 005 | `api/web/src/components/CloudTAK/util/EmptyInfo.vue` | Fixes type check: `"Missions"` → `"Data Syncs"` | ✅ Applied & valid |
| 006 | `api/web/src/components/CloudTAK/util/ShareToMission.vue` | Changes `<EmptyInfo>` type prop from `'Missions'` to `'Data Syncs'` | ✅ Applied & valid |
| 011 | `api/lib/auth.ts` | Adds `oidcParser()` (ALB JWT header validation), `isOidcEnabled()`, `isOidcForced()` | ✅ Applied & valid |
| 013 | `api/routes/login.ts` | ALB OIDC login/logout routes, Authentik attribute sync, configurable admin groups, ProfileControl for OIDC user creation, OIDC_FORCED system-admin bypass *(covers 017, 021, 023, 025)* | ✅ Applied & valid |
| 014 | `api/routes/server.ts` | Adds `GET /server/oidc` public endpoint returning `oidc_enabled`/`oidc_forced` | ✅ Applied & valid |
| 015 | `api/lib/types.ts` | Adds `oidc_enabled: Type.Optional(Type.Boolean())` to `ServerResponse` | ✅ Applied & valid |
| 016 | `api/web/src/components/Login.vue` | ALB SSO button (`loginWithSSO` → `/api/login/oidc`), `albOidcEnabled`/`albOidcForced` refs, token-in-URL callback, passkey suppressed when ALB SSO active | ✅ Applied & valid |
| 018 | `api/web/src/stores/app.ts` | `appStore.logout()` redirects to `/api/logout` to expire ALB cookies | ✅ Applied & valid |
| 020 | `api/nginx.conf.js` | Increases `large_client_header_buffers` for large ALB OIDC headers | ✅ Applied & valid |
| 024 | `api/lib/control/profile.ts` | Fixes `icon_rotation` boolean parse (`=== 'false'` → `=== 'true'`) | ✅ Applied & valid |
| 026 | `api/lib/authentik-provider.ts` | Import path fixes (`./fetch.js` → global fetch, `./external.js` → `./interface-user.js`), ESLint cleanup; all methods were already in upstream v13 | ✅ Applied & valid |
| 027 | `api/routes/ldap.ts` | On-demand Authentik profile ID lookup when `profile.id` is null | ✅ Applied & valid |
| 028 | `api/routes/agency.ts`, `api/web/src/components/ETL/Connection/AgencyBadge.vue`, `api/derived-types.d.ts` | Adds optional `description` field to `AgencyResponse` | ✅ Applied & valid |
| 030 | `api/routes/connection.ts` | Agency field changes on a connection restricted to system admins only | ✅ Applied & valid |
| 031 | `api/routes/connection.ts` | On connection delete: revoke TAK cert + delete Authentik service account; cert renewal endpoints (`POST /connection/:id/cert/renew`, `GET /layer/:id/health`) | ✅ Applied & valid |
| 032 | `api/lib/authentik-provider.ts` | `deleteMachineUser()` method (safe delete with `machineUser: true` guard) | ✅ Applied & valid |
| 033 | `api/lib/cert-health.ts` *(new file)* | `needsCertRenewal()` helper: cert missing / invalid / expiring within N days | ✅ Applied & valid |
| 034 | `api/package.json` | Adds `axios` dependency (required for ALB OIDC JWT public-key fetching) | ✅ Applied & valid |
| 036 | `api/routes/login.ts`, `api/web/src/components/Login.vue` | `OIDC_FORCED` system-admin bypass: backend 403 for non-admin local login; frontend redirects to SSO on that 403; `?local=true` URL param bypasses redirect | ✅ Applied & valid |
| 042 | `api/routes/icons.ts` | Returns empty sprite instead of 400 when iconset has no spritesheet data | ✅ Applied & valid |
| 043 | `api/web/src/components/Login.vue` | Sets `loading=true` before forced SSO redirect to prevent form flash; dynamic loading message ("Redirecting to SSO..." / "Completing login...") | ✅ Applied & valid |
| 044 | `api/lib/sprites.ts` | Fixes regex so icon filenames with dots produce correct sprite keys | ✅ Applied & valid |
| 045 | `api/routes/profile-overlays.ts` | Unhide existing overlay on duplicate POST instead of erroring; delete associated iconset on overlay delete | ✅ Applied & valid |
| 048 | `api/web/src/workers/atlas-connection.ts` | Exponential-backoff WebSocket reconnect (max 5 attempts, 1s → 10s) | ✅ Applied & valid |
| 049 | `api/web/src/base/events.ts`, `api/web/src/stores/map.ts`, `api/web/src/workers/atlas.ts` | Auto-logout on auth/connection error: `Session_Logout` event, redirect to `/api/logout` from main thread | ✅ Applied & valid |
| 050 | *(note)* | Tab visibility reconnect — **superseded by upstream v13** (`reconnect()` and `_boundOnVisibilityChange` already in baseline) | ⬜ Superseded |
| 051 | `api/lib/authentik-provider.ts`, `api/routes/connection.ts`, `api/routes/login.ts` | Cert renewal uses password auth instead of potentially-revoked cert; removes stale cert-revocation check from login.ts | ✅ Applied & valid |
| 053 | `api/lib/connection-web.ts`, `api/web/src/base/chatroom-chats.ts`, `api/web/src/components/CloudTAK/Menu/MenuChat.vue`, `api/web/src/components/CloudTAK/Notifications.vue`, `api/web/src/workers/atlas-connection.ts` | Chat/presence fixes: plugin dest routing, chatroom DB ops without fetch(), notification routing, markRead(), scroll-to-bottom, timestamps, Notifications layout | ✅ Applied & valid |

---

## Removed / Consolidated Patches

The following patches were removed. The reason is noted in each case.

| Patch | Reason removed |
|---|---|
| 017 | Covered by 013 (same file: `login.ts`) |
| 019 | Covered by 003 (same file: `MainMenuContents.vue`) |
| 021 | Covered by 013 (same file: `login.ts`) |
| 022 | Obsolete — `ProfileControl.generate()` now syncs all display defaults generically, superseding this single-field fix |
| 023 | Covered by 013 (same file: `login.ts`) |
| 025 | Covered by 013 (same file: `login.ts`) |
| 029 | Superseded by upstream v13 — `LoginModal.vue` never existed in baseline; `App.vue` already uses `appStore.routeLogin()` |
| 035 | Covered by 031 (same file: `connection.ts`) |
| 037 | Obsolete — `config.external` abstraction removed by upstream v13; `External.init()` and `config.external = AuthentikProvider` wiring replaced by per-route `AuthentikProvider.init()` calls; debug logging was not production-appropriate |
| 046 | Superseded by upstream v13 — `getSource()` guards before every `addSource()` already in `overlay-class.ts` |
| 047 | Superseded by upstream v13 — `addSprite()`/spritesheet loading architecture replaced by on-demand `cloudtak-sprite://` protocol |
| 050 | Superseded by upstream v13 — `reconnect()` and `_boundOnVisibilityChange` already in baseline |
| 052 | Obsolete — target code (per-login cert enrollment in `login.ts`) no longer exists; race condition cannot occur |

---

## Notes for Future Upstream Syncs

1. **Apply patches in order** by number. Some patches cover the same file; where one file has multiple patches, they were written as a single cumulative diff from the v13 baseline, so only one of them needs to be applied per file (see the "Covered by" notes above).

2. **Regenerating stale patches:** after applying upstream changes, regenerate with:
   ```bash
   git diff 418bdc4be HEAD -- <file(s)> > scripts/patches/<name>.patch
   # verify: git apply --check --reverse scripts/patches/<name>.patch
   ```
   Replace `418bdc4be` with the new upstream baseline commit after each sync.

3. **Patches 050 (tab visibility), 046/047 (overlay/sprite architecture):** these were superseded by upstream before our v13 sync. If upstream regresses these features, the README files in `scripts/patches/` for each have the original implementation notes.

4. **`OIDC_FORCED` system-admin bypass** (patch 036): system admins can log in locally by navigating to `/login?local=true`. The frontend skips the auto-redirect and shows the login form; the backend blocks non-admin users with a 403 that the frontend catches and converts to an SSO redirect.
