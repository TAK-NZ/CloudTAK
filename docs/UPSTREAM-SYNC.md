# Upstream Sync Runbook

How TAK-NZ pulls `api/` and `tasks/` from upstream
[dfpc-coe/CloudTAK](https://github.com/dfpc-coe/CloudTAK) while keeping its own
customizations.

## The short version

```bash
scripts/sync-upstream.sh --latest-tag
```

Resolve anything it lists, commit, run the checks it prints, push **both** the
sync branch and `vendor/upstream`, then merge the PR **with a merge commit**.

---

## Why it works this way

TAK-NZ carries changes upstream will not take, or takes slowly: in-app OIDC,
Authentik certificate enrollment, LINZ basemaps, branding. Roughly **83 upstream
files modified (~3,700 lines), plus ~130 TAK-NZ-only files.**

The sync used to be:

```bash
git checkout "$UPSTREAM_TAG" -- api/ tasks/     # ← the old way
```

That is not a merge. It has no "ours" side — it **deletes** every TAK-NZ change
in those directories and replaces them with pristine upstream. The changes then
had to be reinstated by hand from `scripts/patches/`. That is how the v13 port
lost TAK certificate provisioning entirely, lost first-login attribute sync, and
wrote TAK attributes to a table with no such columns. Five follow-up fix commits.

Reinstating by hand could not have worked reliably anyway:

- The patch set covered **57 of the 83** modified files. The 30 with no patch
  included the OIDC test suite, `ConfigLogin.vue`, `SettingsCallsign.vue`,
  `lib/style.ts` and `lib/logos.ts`.
- `scripts/apply-patches.sh` never ran to completion and nothing invoked it.
- After upstream moved `api/lib/` to `api/common/` + `api/stateless/` in
  v13.62.0, **25 of 45 patches pointed at paths that no longer exist.**

So: stop deleting our own work. Let git merge instead.

## How the merge base works

Git merges by comparing three trees: ours, theirs, and the **common ancestor**.
Given a correct ancestor it works out "upstream changed these lines, TAK-NZ
changed those, no overlap, keep both" by itself.

Because past syncs were overwrites, git had no record of which upstream version
our tree derived from — the last genuine shared commit was from June 2025. A
plain `git merge v13.62.0` therefore produced **1,241 conflicted files.**

`vendor/upstream` fixes that. It is a branch holding **pristine upstream `api/` +
`tasks/` and nothing else** — no TAK-NZ changes, ever. Each sync appends a commit
advancing it to a new upstream release, then merges it into a sync branch.
Because the *previous* vendor commit is an ancestor of `main`, git has exactly
the right merge base.

Measured on the same v13.26.0 → v13.62.0 jump (690 upstream files changed,
+170k/−20k lines, including the whole `api/lib` restructure):

| | conflicts |
|---|---|
| plain `git merge` (poisoned ancestor) | 1,241 files |
| **via `vendor/upstream`** | **31 files** (27 real, 4 just `git add`) |
| old overwrite + manual re-port | all 83 files, by hand, from an incomplete patch set |

Git also followed the renames: our `isOidcEnabled()` / `isOidcForced()` changes
in `api/lib/auth.ts` landed in `api/common/auth.ts` automatically.

## Doing a sync

```bash
git checkout main && git pull
scripts/sync-upstream.sh --latest-tag        # or --tag v13.62.0 / --main
```

The script creates `sync/upstream-<timestamp>`, advances `vendor/upstream`, and
merges. It refuses to run on a dirty tree and **fails loudly if the merge base is
missing** rather than producing a 1,200-conflict mess.

Conflicts are grouped by kind:

- **both sides changed** — the real work. Upstream and TAK-NZ touched the same
  code. `scripts/patches/*.patch` and
  [`scripts/patches/PATCH_AUDIT.md`](../scripts/patches/PATCH_AUDIT.md) explain
  why each customization exists; use them as reference. They are a historical
  record, not applicable patches.
- **TAK-NZ-only files upstream relocated** — usually just `git add`.
- **deleted on one side** — decide whether the customization still applies. If
  upstream implemented it properly, drop ours.

Then:

```bash
git add <files> && git commit                # the merge commit is pre-staged
cd api  && npm ci && npx tsc --noEmit
cd web  && npm ci && npm run lint && npm test
git push -u origin sync/upstream-<timestamp> vendor/upstream
```

Open a PR against `main`.

## ⚠️ Merge PRs with a merge commit — never squash

Squash and rebase merges discard the second parent. That destroys the ancestry
`vendor/upstream` provides, and the next sync degrades to ~1,200 conflicts.

Recommended: disable "Squash merging" and "Rebase merging" for this repository in
**Settings → General → Pull Requests**.

If it happens anyway, repair it — this changes no files:

```bash
git branch -D vendor/upstream
scripts/sync-upstream.sh --seed "$(cat .upstream-version)"
```

## Recommended local setting

```bash
git config rerere.enabled true
```

Git then records how you resolved each conflict and replays it if the same
conflict recurs. Worth it for files like `login.ts` that conflict most syncs.

## Sync little and often

The old process cost the same no matter how long you waited — you re-ported
everything regardless. Merging costs in proportion to upstream's delta. The
31-conflict figure above is a six-month, 36-release jump; weekly syncs conflict
in a handful of files. `.github/workflows/weekly-sync.yml` runs Saturdays 2AM
NZST, gated on the `SYNC_MODE` repository variable (`tag` or `main`). On a clean
merge it opens a PR; on conflicts it advances `vendor/upstream` and opens an
issue, because resolution has to happen on our side.

> Do **not** resolve conflicts using GitHub's web conflict editor on a
> `vendor/upstream` PR — it would commit TAK-NZ code onto the vendor branch and
> destroy the "pristine upstream" invariant. Resolve locally.

## Reducing the conflict surface

Independent of mechanism, the cheapest conflict is one that never happens. Our
~3,700 changed lines are heavily skewed: about 40 of the 83 files change ≤10
lines, while the weight sits in `routes/login.ts` (374), `Login.vue` (247),
`routes/basemap.ts` (228), `stores/map.ts` (180), `routes/ldap.ts` (176),
`lib/config.ts` (164).

TAK-NZ-only *new* files (`oidc.ts`, `cert-health.ts`, `authentik-provider.ts`,
`terrain.ts`) cost nothing — they cannot conflict. Every line moved out of an
inline edit into a new file, an extension point or env-driven config stops
conflicting forever. `login.ts` and `map.ts` are the two best candidates.

And keep filing upstream feature requests (`UPSTREAM-FEATURE-REQUEST*.md`) —
every accepted change is a permanent deletion from what we carry.

## Files involved

| Path | Role |
|---|---|
| `vendor/upstream` (branch) | Pristine upstream `api/` + `tasks/`. Never contains TAK-NZ code. |
| `.upstream-version` | The upstream ref currently merged into `main`. |
| `scripts/sync-upstream.sh` | Does the sync. Exit codes: 0 merged, 5 up to date, 10 conflicts, 1 error. |
| `.github/workflows/weekly-sync.yml` | Weekly automation. |
| `scripts/patches/` | **Historical record** of why each customization exists. Not applied. |
| `scripts/post-sync-validate.sh` | Advisory checks. Hardcodes pre-v13.27 paths (`lib/schema.ts`, `routes/`), so it misreports after an upstream restructure. |

## First-time setup

Already done, recorded here for reference. Needed only if `vendor/upstream` is
lost entirely:

```bash
scripts/sync-upstream.sh --seed v13.26.0     # the version main's api/ derives from
git push -u origin vendor/upstream
git push origin HEAD
```

`--seed` builds the vendor branch and joins it to history with
`git merge -s ours`, which records the ancestry while changing **no files** — the
script verifies the resulting tree is byte-identical and aborts if it is not.
