# Fork delta: how TAK-NZ differs from upstream in `api/` and `tasks/`

This document explains **why** each TAK-NZ change to the synced application code
exists. That rationale is the reason this file is worth keeping: it is the one
thing git cannot reconstruct for you.

## What is authoritative, and what is not

**The file inventory is not maintained here.** It is derived from git on demand,
so it can never be stale:

```bash
# every file where TAK-NZ differs from the synced upstream tree
git diff --numstat vendor/upstream...HEAD -- api/ tasks/

# the full diff for one area
git diff vendor/upstream...HEAD -- api/stateless/routes/login.ts
```

At v13.70.0 that is **98 code files** plus **113 logo/icon assets** under
`api/web/public/logos/`. `vendor/upstream` tracks the synced upstream tree; the
version currently synced is in [`.upstream-version`](../../.upstream-version).

**This document is the rationale layer on top of that diff.** It is grouped by
concern rather than by file, because most changes span several files, and it is
keyed by the paths that exist *today*. When you move or rename something, update
the paths here.

> ### Why there are no `.patch` files any more
>
> Until v13.70.0 this directory also held 45 `.patch` files. They were deleted,
> and the reasoning is worth recording so nobody recreates them.
>
> They stopped being applicable long before they were deleted. Upstream syncs are
> a real 3-way merge via the `vendor/upstream` branch, so TAK-NZ changes are
> carried forward by git and never need reinstating — see
> [`docs/UPSTREAM-SYNC.md`](../UPSTREAM-SYNC.md). Their only remaining job was as
> a reference while resolving merge conflicts.
>
> They failed even at that. Measured at v13.70.0, when they were removed:
>
> - **8 of 45** still matched the tree under `git apply --reverse --check`.
> - **19 of 45** had *every* target path missing; 8 more were partly missing.
>   Upstream's restructure moved `api/lib/` into `api/common/` and
>   `api/stateless/lib/`, and `api/routes/` into `api/stateless/routes/`. Git's
>   merge followed those renames automatically. The patch headers did not.
>
> So at the exact moment you would reach for one, it pointed at a path that no
> longer existed — worse than nothing, because it looked authoritative.
>
> Earlier problems, recorded here because they explain why the model was wrong
> rather than merely out of date:
>
> - `apply-patches.sh` applied patches **sequentially**, but they were
>   **cumulative diffs from a shared baseline**. Those two models contradict each
>   other for any file touched by more than one patch, and 19 of 57 files were.
>   Running the script against its own baseline died at patch 031, because 030 had
>   already added those lines. Nothing in the repo ever invoked the script, and it
>   has been removed.
> - They were **incomplete as a recovery mechanism**: the fork modified 83
>   upstream files and the patches covered 57. The 26 with no patch included the
>   OIDC test suite, `ConfigLogin.vue`, `SettingsCallsign.vue`, `lib/style.ts` and
>   `lib/logos.ts`. Reinstating from patches alone would have silently dropped all
>   of them — the same class of failure that lost TAK certificate provisioning
>   during the v13 port.
>
> The deleted files remain in git history if you ever need one.

---

## Authentication and identity

The largest single area. TAK-NZ replaces upstream's authentication with an in-app
OIDC flow against Authentik, and provisions TAK certificates as part of login.

### In-app OIDC login

`api/stateless/routes/login.ts`, `api/stateless/lib/oidc.ts`,
`api/common/auth.ts`, `api/stateless/routes/server.ts`, `api/common/types.ts`,
`api/web/src/components/Login.vue`, `api/web/src/stores/app.ts`

An Authorization Code flow run by the application itself. `oidcParser()`,
`isOidcEnabled()` and `isOidcForced()` live in `api/common/auth.ts`;
`GET /server/oidc` exposes `oidc_enabled` / `oidc_forced` publicly so the login
page can decide what to render, backed by `oidc_enabled` on `ServerResponse`.

**The user is identified by `preferred_username`, falling back to `email`.**
`Profile.username` (the CloudTAK primary key for a user) used to be populated
unconditionally from the userinfo `email` claim, which both assumed every
Authentik account has an email attribute and assumed CloudTAK's own record key
should be that email rather than the Authentik `username`. Neither holds once
Authentik usernames diverge from email (some are not email-shaped, some accounts
have no email at all). `preferred_username` is used as-is if present (no
lowercasing — Authentik usernames are a case-sensitive unique field, so
lowercasing risks merging two distinct accounts), falling back to a lowercased
`email` only if `preferred_username` is absent. The callback still 400s if
userinfo returns neither claim.

This replaced an earlier ALB-based design where the load balancer performed the
OIDC handshake and injected JWT headers. Two consequences of that move are easy
to misread as unnecessary:

- `Login.vue` reads the session from the `/login#sso=<payload>` URL **fragment**,
  not a query string, deliberately — a fragment stays out of server access logs
  and browser history.
- `getUsername()` / `storedUsername` are populated at the very top of
  `onMounted()`, before any login-consuming branch runs. They used to be set
  afterwards, which meant `applySession()`'s stale-profile-wipe check always saw
  `storedUsername=null` on a fresh SSO redirect. A browser previously used for one
  Authentik account could then leak its cached profile and WebSocket state into a
  different user's new session.

`OIDC_FORCED` still allows system admins to log in locally via
`/login?local=true`: the frontend skips the auto-redirect and shows the form, and
the backend returns 403 for non-admins, which the frontend converts into an SSO
redirect.

See [`README-OIDC.md`](README-OIDC.md) and
[`README-OIDC-FORCED.md`](README-OIDC-FORCED.md).

### TAK certificate enrollment, and the concurrency lock

`api/stateless/lib/authentik-provider.ts`, `api/stateless/routes/login.ts`

`enrollUserCertificate(username, takServerUrl)` sets a random temporary password
on the Authentik account, generates a TAK client certificate via
`APIAuthPassword` + `Credentials.generate()`, then revokes the temp password in a
`finally` block. The v13 port dropped certificate provisioning entirely, leaving
every OIDC user with an empty `auth` — restoring it is why this exists.

**The advisory lock is load-bearing.** Because the temporary password is set on
the *shared* Authentik account, two concurrent logins for the same user can
interleave: one request's password-set lands between the other's password-set and
its TAK Server login, and that login fails with a stale-credential `400`/`405`.
This was confirmed in production logs — a `499` aborted `/login/oidc` followed
5.6s later by a `302`-completing one, same user. The set-password → TAK-login →
revoke sequence is wrapped in `pg_advisory_xact_lock`, keyed on a hash of the
username, so it serialises correctly across ECS tasks.

**Certificate enrollment and attribute sync have separate `try`/`catch` blocks,
deliberately.** They used to share one, so a cert-enrollment failure aborted the
block before the callsign/group/role sync ran at all — the sync was never
reached, let alone failed. Do not recombine them.

**Both enrollment paths must resolve the real Authentik `username` before using
it as the certificate CN/clientUid.** The M2M path
(`enrollUserCertificateViaM2M`) now calls `findUserByEmailOrUsername()` up front,
same as the temp-password fallback always has — it previously built the CSR
`commonName` and `clientUid` directly from whatever identifier the OIDC callback
passed in (the `preferred_username`/`email` claim), which is not guaranteed to
equal the Authentik `username` field. Without the lookup, a person's certificate
subject would differ depending on which of the two enrollment paths happened to
succeed for them.

See [`README-CERT-ENROLLMENT-RACE.md`](README-CERT-ENROLLMENT-RACE.md).

### Authentik attribute sync

`api/stateless/routes/login.ts`, `api/stateless/lib/authentik-provider.ts`

Attribute sync is unconditional on first login (`profile.created ===
profile.updated`) so the "Welcome" wizard is suppressed for SSO users; later
logins respect `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN`.

TAK attributes (`tak::callsign`, `tak::remarks`, `tak::group`, `tak::role`) are
written via `ProfileConfig.commit()`. They were previously passed to
`Profile.commit()`, which silently dropped them because they are not columns on
the `profile` table.

`login()` returns `tak_role` from `attributes.takRole`.

**On the callsign suffix:** `login()` used to append `" (Web)"` to
`attributes.takCallsign`. That was **removed at v13.70.0** to match upstream. The
`" (Web)"` suffix is deliberately *kept* on the certificate `clientUid`, which is
a different identifier and prevents a browser session's certificate colliding
with the same person's device certificate.

### Authentik service accounts and LDAP

`api/stateless/lib/authentik-provider.ts`, `api/stateless/routes/ldap.ts`,
`api/stateless/routes/connection.ts`, `api/stateless/routes/agency.ts`,
`api/web/src/components/ETL/Connection/AgencyBadge.vue`

- `deleteMachineUser()` deletes safely behind a `machineUser: true` guard.
- All three LDAP routes fall through to Authentik when CoTAK is not configured.
- On-demand Authentik profile ID lookup when `profile.id` is null.
- Agency changes on a connection are restricted to system admins.
- `AgencyResponse` gains an optional `description` field.

### Certificate lifecycle

`api/stateless/lib/cert-health.ts`, `api/stateless/routes/connection.ts`,
`api/stateless/routes/connection-layer.ts`

`needsCertRenewal()` reports missing, invalid, or expiring-within-N-days.
Connection delete revokes the TAK certificate and deletes the Authentik service
account. `POST /connection/:id/cert/renew` and `GET /layer/:id/health` expose
renewal and health. Renewal authenticates by password rather than by the
certificate being replaced, which may already be revoked.

See [`README-CERT-RENEWAL.md`](README-CERT-RENEWAL.md).

### Auth-failure logout

`api/web/src/utils/events.ts`, `api/web/src/stores/map.ts`,
`api/web/src/workers/atlas.ts`, `api/web/src/stores/app.ts`

A `Session_Logout` event redirects to `/api/logout` from the main thread on
auth or connection error. `appStore.logout()` also redirects there to expire
cookies.

See [`README-AUTO-LOGOUT.md`](README-AUTO-LOGOUT.md).

---

## Configuration and deployment

### Server configuration and admin provisioning

`api/common/config.ts`, `api/Dockerfile`, `api/nginx.conf.js`

`CLOUDTAK_Server_*` environment seeding, `MediaSecret` / DynamoDB / VPC config
fields, and admin profile provisioning. Also `tileOriginHostnames`, parsed from
`CLOUDTAK_TILE_ORIGINS`.

`api/nginx.conf.js` generates the Content-Security-Policy header, including
`frame-ancestors` and the embedding allowlist, and injects the trusted tile CDN
origins into `connect-src` / `img-src` at container start.

The `large_client_header_buffers` increase was **removed** once OIDC moved
in-app — it existed only for large ALB-injected OIDC cookies.

See [`README-ADMIN-ENV-VARS.md`](README-ADMIN-ENV-VARS.md).

---

## Basemaps, tiles and terrain

### TileJSON, sprites and CSP

`api/common/types.ts`, `api/stateless/routes/basemap.ts`,
`api/stateless/lib/interface-basemap.ts`, `api/web/src/base/overlay-class.ts`,
`api/web/src/stores/map.ts`

Adds `sprite` / `glyphs` to the `TileJSON` schema and merges the `tilejson` blob
into PMTiles and non-URL TileJSON responses. Upstream's `sprite` / `glyphs` are
stripped to prevent CSP leakage.

The LINZ topographic sprite is loaded **directly** from
`basemaps.linz.govt.nz`, which serves `Access-Control-Allow-Origin: *`, rather
than proxied through the API. The tile proxy is bypassed in the TileJSON endpoint
when the basemap hostname is in the trusted set. An earlier design proxied the
sprite through `GET /api/basemap/sprite/:name.json|.png` and registered sprites
per overlay reactively; that caused timing races and was replaced by loading the
sprite unconditionally in the map init style.

`vector_layers` is emitted **only when actually known**. Upstream's
`[{id:'out'}]` default is CloudTAK's ETL convention and is wrong for proxied LINZ
tiles; there is no `vector_layers` column, so it always fired. v13.26.0 emitted
none. Cosmetic — MapLibre warns and still renders — but the ~285 console errors
masked a real hillshade bug.

See [`README-SPRITE-DUPLICATE.md`](README-SPRITE-DUPLICATE.md).

### Hillshade and terrain sources

`api/stateless/lib/interface-basemap.ts`, `api/web/src/base/overlay-class.ts`

`ensureTerrainSource()` and the `__terrain__` sentinel let a hillshade layer
reference a raster-dem source that may not exist yet; `OverlayManager` re-attempts
deferred hillshade layers when the source arrives, and
`BasemapProtocol.isValidStyle()` accepts hillshade layers using either.

**The source must be added by passing the TileJSON `url` to `addSource()`, not a
spread TileJSON object.** MapLibre 6.4.1 rejects unknown properties
(`tilejson`, `version`, `name`, `description`, `scheme`, `center`, `actions`), and
`Style.addSource()` returns early when it does — so `__terrain__` never existed
and relief shading silently vanished.

Related: `initOverlays()` calls `this.updateBackground()` after
`OverlayManager.appendLoaded(...)`, because `visibleBasemaps()` reads `loaded`,
which was still empty when `addLayers()` ran — that was the missing ocean fill.

`namespaceStyles()` in `overlay-class.ts` copies rather than mutates, so layer-id
prefixing is idempotent. `replace()` used to mutate the caller's array, and
`MenuBasemaps` passes `basemap.styles` straight from component state, which grew
ids like `23-23-23-Background` on every re-selection.

### Server-side elevation

`api/stateless/lib/terrain.ts`, `api/stateless/lib/interface-basemap.ts`,
`api/stateless/routes/search.ts`,
`api/web/src/components/CloudTAK/Query/Elevation.vue`

`Elevation.vue` used MapLibre's `queryTerrainElevation()`, which only returns a
value once 3D terrain rendering is active — a GPU-heavy mode not otherwise needed
for a one-off lookup, and reported to crash some hardware.

`BasemapProtocol.tileBuffer()` fetches a single tile's bytes in-process by reusing
each protocol's existing `_tile()` behind a minimal in-memory `Response` stand-in,
so it works for any protocol with no per-protocol changes. `getElevation()`
resolves the configured `map::terrain` basemap, computes the covering tile and
pixel via `pointToTileFraction()`, decodes with `sharp`, and applies the Mapbox
Terrain-RGB or Terrarium formula according to the basemap's `encoding`. Wired into
`GET /search/reverse/:longitude/:latitude/elevation`, falling back to the
client-supplied `elevation` param when no terrain basemap is configured.

See [`README-SERVER-SIDE-ELEVATION.md`](README-SERVER-SIDE-ELEVATION.md).

### PMTiles task

`tasks/pmtiles/**`

Elevation and profile route additions with their test suites, plus
`tasks/pmtiles/src/lib/auth.ts`. Note the LINZ vector style JSON files in
`LINZ_Vector_Map_Styles/` prefix every `fill-pattern`, `line-pattern` and
`icon-image` with `linz-topographic:` to match the sprite id MapLibre assigns to
non-default named sprites.

---

## Icons, sprites and styling

`api/stateless/routes/icons.ts`, `api/stateless/lib/logos.ts`,
`api/common/style.ts`, `api/web/src/stores/modules/icons.ts`,
`api/web/public/logos/**`

- An iconset with no spritesheet data returns an empty sprite rather than a 400.
- The sprite-key regex handles icon filenames containing dots.
- `GET /api/icon` sends `ETag` and `Cache-Control: public, max-age=3600` when
  filtered to a single iconset, so browsers can 304 instead of re-downloading up
  to 10 MB of base64 icon data after an IndexedDB clear. Unfiltered requests get
  `no-store`.
- Large raster icons are scaled to 32px max via canvas, so an oversized icon
  cannot fill the screen.
- 113 logo and app-icon assets are TAK.NZ branding.

See [`README-EMPTY-ICONSET-FIX.md`](README-EMPTY-ICONSET-FIX.md) and
[`README-SPRITE-ICON-DOTS.md`](README-SPRITE-ICON-DOTS.md).

### ATAK icon set

`api/web/src/stores/modules/menu.ts`,
`api/web/src/components/CloudTAK/DrawTools.vue`,
`api/web/src/components/CloudTAK/util/DrawOverlay.vue`,
`api/web/src/components/CloudTAK/Inputs/{RangeInput,RangeRingsInput,GeoJSONInput}.vue`

ATAK-CIV icons for the navigation menu (16 of 18) and drawing tools (12 of 13),
supplied by two TAK-NZ-only modules under `api/web/src/base/` that upstream will
never create, so they cannot conflict. Each consuming file changes in exactly two
places — one import and one `.map()` — leaving upstream's arrays byte-identical.
Selection and provenance are in `branding/atak-icons/`; attribution is in
`NOTICE` at the repo root.

`DrawOverlay.vue` binds the ATAK icons to upstream's Tabler import names so its
template stays byte-identical. The sector icon's mask id is made unique per
component instance, because the palette and this pane can both render it at once.

---

## Overlays and profile

`api/stateless/routes/profile-overlays.ts`, `api/stateless/routes/profile.ts`,
`api/stateless/lib/control/profile.ts`,
`api/web/src/components/CloudTAK/Menu/MenuOverlays.vue`

A duplicate overlay POST unhides the existing overlay instead of erroring, and
deleting an overlay deletes its associated iconset. `icon_rotation` boolean
parsing was inverted (`=== 'false'` where it should have been `=== 'true'`).

See [`README-IDEMPOTENT-OVERLAY.md`](README-IDEMPOTENT-OVERLAY.md).

---

## Chat

`api/stateful/lib/connection-web.ts`, `api/stateful/lib/connection-pool.ts`,
`api/web/src/base/chatroom.ts`, `api/web/src/base/chatroom-chats.ts`,
`api/web/src/components/CloudTAK/Menu/MenuChat.vue`,
`api/web/src/components/CloudTAK/Notifications.vue`

**Directed-chat routing is a security fix, not a tidy-up.** The plugin
dest-routing block used to *replace* the UID-based `<marti><dest uid="..."/>` with
a callsign-only dest. TAK Server resolves callsign destinations through a single
global, non-unique `callsign -> subscription` map, and CloudTAK gives every new
profile the same default callsign (`"CloudTAK User"`) — so a directed chat could
reach the wrong user. It now uses `chat.addDest({ callsign })` to add the callsign
dest *alongside* the UID dest. UID-based explicit brokering still wins for
routing, and plugins reading `xmlDetail` still find a callsign.

A bare `<dest callsign="...">` sibling under `<detail>` was also dropped. It had
been added on the assumption that TAK Server strips `<marti>` before building
`xmlDetail`; checking TAK Server's own source
(`StreamingProtoBufHelper.cot2protoBuf()`, `takserver-plugins`) shows it extracts
a fixed allowlist and passes everything else, `<marti>` included, through
unmodified. The `addDest()` call alone suffices.

Other fixes in this area:

- `connection-pool.ts` includes `from.uid` in the WebSocket `chat` push echoed to
  the sender. Without it the client's optimistic local echo was overwritten with
  `sender_uid === undefined`, rendering your own message on the wrong side until
  reload.
- `Chatroom.deleteChats()` deletes the message ids from `db.chatroom_chats` after
  the server delete succeeds. This gap exists upstream too but is invisible there,
  because upstream's wipe-and-repopulate `refresh()` incidentally covers it.
- `chatroom-chats.ts`'s `refresh()` indexes `items[0]`, the newest message, when
  updating `chatroom.updated`. It used to take the last item, the oldest in the
  page.
- `MenuChat.vue` keys its local-DB subscription and server refresh off the
  resolved chatroom name rather than the literal `'new'` URL segment. Every
  "start chat" button routes via `/menu/chats/new?callsign=...`, so an existing
  conversation opened that way showed empty.
- `sendMessage()` sets a `skipNextRefresh` flag before navigating away from
  `/new`, so the post-send refresh cannot race the TAK Server echo and roll back
  optimistic state.
- A debug `console.log(JSON.stringify(feat))` that logged full mission-chat
  payloads, message text included, to server logs was removed.

See [`README-CHAT-FUNCTIONALITY.md`](README-CHAT-FUNCTIONALITY.md),
[`README-CHAT-ECHO-SENDER-UID.md`](README-CHAT-ECHO-SENDER-UID.md) and
[`README-CHAT-DELETE-LOCAL-SYNC.md`](README-CHAT-DELETE-LOCAL-SYNC.md).

---

## WebSocket lifecycle and the login race

`api/web/src/workers/atlas-connection.ts`, `api/web/src/workers/atlas.ts`,
`api/web/src/workers/atlas-database.ts`, `api/web/src/workers/atlas-profile.ts`,
`api/web/src/stores/map.ts`, `api/web/src/components/Login.vue`,
`api/web/src/components/CloudTAK/Map.vue`

Exponential-backoff reconnect, capped at 5 attempts over 1s → 10s, with
auth-failure detection.

**The mount/unmount guards in `mapStore` are not defensive padding.** `Login.vue`
used to signal completion with `emit('login')`, which `App.vue` routed to the
async `appStore.refreshLogin()` while discarding its promise, then navigated
immediately. `refreshLogin()` sets `appStore.loading = true` synchronously, and
`App.vue` gates `<router-view>` on that flag — so any interleaving where the route
reached `/` while it was still set tore down the just-mounted `Map.vue` and
remounted it a tick later, running `mapStore.destroy()` and `mapStore.init()`
concurrently against the same singleton.

That overlap is unrecoverable: `startWorker()` early-returns while `_rawWorker` is
still set, so the new `init()` binds to a worker the teardown is about to
`terminate()`, and Comlink RPCs against a terminated worker never settle. The
result was a permanent loading spinner with no timeout anywhere in the chain.

The fix has three parts, all of which need to stay together:

1. `Login.vue` awaits `appStore.refreshLogin()` via `settleSession()` before
   navigating, and bails out if the session did not verify. Auth state settles
   while still on `/login`, where App.vue's gate is exempt, so `Map.vue` mounts
   exactly once.
2. `mapStore` gains **module-level** `destroyPromise` and `lifecycle` handles —
   deliberately not state-resident, since `$reset()` would roll them back.
   `destroy()` coalesces concurrent teardowns and bumps the counter; `init()`
   waits for any in-flight teardown, then re-checks at each await whether it has
   been superseded, returning `false` and disposing any orphaned MapLibre
   instance. The graceful worker-shutdown RPC is bounded at 2s before
   `terminate()`, because `init()` waits on it.
3. `Map.vue` honours `init()`'s boolean return and stops wiring up a superseded
   mount.

See [`README-WEBSOCKET-RECONNECTION.md`](README-WEBSOCKET-RECONNECTION.md) and
[`README-OIDC-WEBSOCKET-FIXES.md`](README-OIDC-WEBSOCKET-FIXES.md).

---

## Self-location rendering

`api/web/src/base/cot.ts`, `api/web/src/workers/atlas-profile.ts`

`COT.styleProperties()` applied group-based `marker-color` / `icon-opacity` to
every Point feature carrying a `group`, including the user's own self-location.
Because `marker-opacity` was never set alongside it, node-cot's `from_geojson()`
defaulted alpha to ~50% — emitting a semi-transparent `<color argb>` that native
ATAK and WinTAK never send for team members, and the suspected cause of team
markers rendering faded or invisible on ATAK 5.7.

`isSelf` is its own **top-level** branch, not an `else if`. An earlier attempt
excluded self only from the first branch, so self with no pre-existing icon fell
through to the generic fallback, got `properties.icon` set, and rendered a second
icon on top of the GeolocateControl puck. The branch also explicitly `delete`s
`marker-color`, `marker-opacity`, `icon-opacity` and `icon` on both the fresh
properties and the long-lived `COT#_properties`, because `Object.assign` never
clears keys a payload omits — so stale values self-heal on the next update.

`COT.selfUid` is set in `AtlasProfile.uid()` rather than relying solely on
`AtlasDatabase.init()`, closing a race where the first self-location update could
fire before it was populated.

---

## Terminology and UI

`api/web/src/components/CloudTAK/MainMenuContents.vue`,
`api/web/src/components/CloudTAK/util/{ChannelInfo,EmptyInfo,ShareToMission,Share,SelectFeats,SettingsCallsign,NotificationIcon}.vue`,
`api/web/src/components/CloudTAK/Menu/{MenuContacts,MenuVideos,MenuSettings,MenuFilesRow}.vue`,
`api/web/src/components/CloudTAK/Map.vue`,
`api/web/src/components/PageFooter.vue`,
`api/web/{index,admin,connection,docs,video}.html`, `api/web/vite.config.ts`

- The Application Switcher dropdown is removed; logout redirects to
  `/api/logout`.
- Upstream's "Data Syncs" is presented as "Missions" where it faces the user, and
  the `EmptyInfo` type check was corrected to match.
- The contacts badge count is fixed and a manual refresh added.
- The video menu is hidden when no media server is configured.
- Upstream's `.maplibregl-ctrl-scale` CSS overrides are removed to keep MapLibre's
  default styling; only `margin: 0` is re-added, because dropping the whole block
  also dropped the positioning.

See [`README-HIDE-LOGIN-FORM.md`](README-HIDE-LOGIN-FORM.md).

---

## Tests

`api/test/login-oidc.srv.test.ts`, `api/test/manifest.srv.test.ts`,
`tasks/pmtiles/test/**`

The OIDC login suite and the PMTiles elevation/profile suites are TAK-NZ
additions. Note the OIDC suite was one of the files the old patch set did not
cover at all.

**Known gap:** nothing covers `AuthentikProvider.login()`'s `takCallsign` →
`tak_callsign` mapping.

---

## Notes for future syncs

1. **Regenerate `api/derived-types.d.ts`** after the new API is live, then commit
   it on the sync branch before merging:
   ```bash
   cd api && npx openapi-typescript https://map.test.tak.nz/api/swagger --output derived-types.d.ts && cd ..
   ```
   It tends to be several versions stale between syncs. `tasks/events` no longer
   has its own copy — upstream removed that file at v13.70.0.

2. **Check for orphaned migrations** before upgrading an environment:
   ```bash
   MIGRATIONS_JOURNAL=<journal for the target version> node scripts/check-migrations.mjs
   ```

3. **Keep the paths in this document current.** It is keyed by real paths, and
   upstream restructures directories — that is precisely what invalidated the
   patch files it replaced. After a sync that moves files, re-run the `git diff`
   at the top and fix any heading that no longer resolves.
