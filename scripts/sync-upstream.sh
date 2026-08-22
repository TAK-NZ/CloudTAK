#!/bin/bash
#
# Sync api/ and tasks/ from upstream dfpc-coe/CloudTAK using a real 3-way merge.
#
# WHY THIS LOOKS THE WAY IT DOES
# ------------------------------
# This script used to run:
#
#     git checkout "$UPSTREAM_REF" -- api/ tasks/
#
# That is not a merge. It has no "ours" side: it deletes every TAK-NZ
# customization in api/ and tasks/ and replaces it with pristine upstream. The
# customizations then had to be re-applied by hand from a patch archive, which
# is how we lost TAK certificate provisioning, first-login attribute sync, and
# wrote TAK attributes to a table that has no such columns during the v13 port.
#
# Instead we keep a `vendor/upstream` branch holding *pristine* upstream api/ +
# tasks/ and nothing else. Each sync advances that branch to the new upstream
# release and merges it into a sync branch. Because the previous vendor commit
# is an ancestor of main, git has a correct merge base and can work out
# "upstream changed these lines, TAK-NZ changed those lines" on its own. Our
# changes are never deleted, so there is nothing to re-apply - we only resolve
# genuine overlaps.
#
# This also survives upstream restructures. When upstream moved api/lib/ to
# api/common/ + api/stateless/ in v13.62.0, git followed the renames and carried
# our auth.ts customizations into the new location automatically. The old patch
# archive did not: by v13.70.0 only 8 of its 45 patches still matched the tree,
# and 19 targeted paths that no longer existed. It has been deleted; the
# rationale it carried now lives in docs/fork/FORK-DELTA.md.
#
# See docs/UPSTREAM-SYNC.md for the full runbook.

set -euo pipefail

UPSTREAM_URL="https://github.com/dfpc-coe/CloudTAK.git"
UPSTREAM_REMOTE="upstream"
VENDOR_BRANCH="vendor/upstream"
VERSION_FILE=".upstream-version"
SYNC_PATHS=(api tasks)

# Machine-readable outcomes, so a caller can distinguish "nothing to do" from
# "needs a human" without parsing output.
EXIT_MERGED=0        # merged cleanly, commit created
EXIT_ERROR=1         # precondition failed / unrecoverable
EXIT_UP_TO_DATE=5    # already on the target upstream version, nothing done
EXIT_CONFLICTS=10    # merge started, needs a human to resolve

RED=$'\033[0;31m'; YEL=$'\033[0;33m'; GRN=$'\033[0;32m'; DIM=$'\033[2m'; OFF=$'\033[0m'

die()  { echo "${RED}❌ $*${OFF}" >&2; exit "$EXIT_ERROR"; }
warn() { echo "${YEL}⚠️  $*${OFF}"; }
ok()   { echo "${GRN}✅ $*${OFF}"; }

usage() {
    cat <<'EOF'
Usage: scripts/sync-upstream.sh [options]

  --latest-tag        Sync to the newest upstream release tag (default)
  --main              Sync to upstream/main
  --tag <ref>         Sync to a specific upstream tag/ref
  --release <ref>     Alias for --tag
  --current-branch    Merge into the current branch instead of a new sync branch
  --seed [<ref>]      Recovery: (re)establish the merge base without changing
                      any file. Use when the ancestry check below fails.
  -h, --help          Show this help

Typical use:
  scripts/sync-upstream.sh --latest-tag
EOF
}

# ---------------------------------------------------------------------------
# Build a commit containing ONLY the pristine upstream SYNC_PATHS.
#
# Done with plumbing against a temporary index so the working tree is never
# touched - no checkout churn, no risk of clobbering local edits, and it works
# identically in CI.
#
#   $1  upstream ref to read from
#   $2  parent commit (empty for the initial orphan commit)
# prints the new commit sha
# ---------------------------------------------------------------------------
build_vendor_tree() {
    local ref="$1" idx tree p

    idx="$(mktemp -t vendoridx.XXXXXX)"; rm -f "$idx"
    GIT_INDEX_FILE="$idx" git read-tree --empty

    for p in "${SYNC_PATHS[@]}"; do
        git rev-parse -q --verify "$ref:$p" >/dev/null \
            || die "upstream ref '$ref' has no '$p/' directory"
        GIT_INDEX_FILE="$idx" git read-tree --prefix="$p/" "$ref:$p"
    done

    tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
    rm -f "$idx"
    echo "$tree"
}

build_vendor_commit() {
    local ref="$1" parent="${2:-}" tree msg

    tree="$(build_vendor_tree "$ref")"

    msg="vendor: upstream ${SYNC_PATHS[*]} at ${ref}

Pristine upstream content only - no TAK-NZ changes. This branch exists solely
to give git a correct merge base for upstream syncs."

    if [ -n "$parent" ]; then
        git commit-tree "$tree" -p "$parent" -m "$msg"
    else
        git commit-tree "$tree" -m "$msg"
    fi
}

resolve_target() {
    case "$MODE" in
        main)     echo "${UPSTREAM_REMOTE}/main" ;;
        explicit) echo "$TARGET_REF" ;;
        tag)
            local t
            t="$(git tag -l 'v*' --merged "${UPSTREAM_REMOTE}/main" --sort=-v:refname | head -1)"
            [ -n "$t" ] || die "could not resolve the latest upstream tag; pass --tag <ref>"
            echo "$t"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
MODE="tag"
TARGET_REF=""
USE_CURRENT_BRANCH=false
DO_SEED=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --latest-tag)     MODE="tag"; shift ;;
        --main)           MODE="main"; shift ;;
        --tag|--release)  MODE="explicit"; TARGET_REF="${2:?--tag needs a ref}"; shift 2 ;;
        --current-branch) USE_CURRENT_BRANCH=true; shift ;;
        --seed)
            DO_SEED=true
            if [[ "${2:-}" != "" && "${2:-}" != --* ]]; then MODE="explicit"; TARGET_REF="$2"; shift 2
            else shift; fi
            ;;
        -h|--help)        usage; exit 0 ;;
        *)                usage >&2; die "unknown option: $1" ;;
    esac
done

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    die "working tree has uncommitted changes to tracked files - commit or stash first
$(git status --short --untracked-files=no | sed 's/^/     /')"
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    echo "📎 adding '$UPSTREAM_REMOTE' remote -> $UPSTREAM_URL"
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

echo "📡 fetching $UPSTREAM_REMOTE ..."
git fetch --quiet --tags "$UPSTREAM_REMOTE"

TARGET="$(resolve_target)"
git rev-parse -q --verify "$TARGET" >/dev/null || die "cannot resolve upstream ref '$TARGET'"
echo "🎯 upstream target: ${GRN}${TARGET}${OFF}"

# ---------------------------------------------------------------------------
# --seed : establish (or repair) the merge base. Changes no files.
# ---------------------------------------------------------------------------
if [ "$DO_SEED" = true ]; then
    [ "$MODE" = "explicit" ] \
        || die "--seed needs the upstream version the current tree derives from, e.g.
     scripts/sync-upstream.sh --seed v13.26.0"

    git rev-parse -q --verify "refs/heads/$VENDOR_BRANCH" >/dev/null \
        && die "$VENDOR_BRANCH already exists. Delete it first if you really mean to re-seed:
     git branch -D $VENDOR_BRANCH"

    vendor="$(build_vendor_commit "$TARGET" "")"
    git branch "$VENDOR_BRANCH" "$vendor"

    before="$(git rev-parse HEAD^{tree})"
    git merge -s ours --allow-unrelated-histories --no-edit "$VENDOR_BRANCH" \
        -m "chore(sync): establish upstream merge base at ${TARGET}

Bookkeeping merge only - changes no files. Records $VENDOR_BRANCH as an
ancestor so upstream syncs can be a real 3-way merge instead of a wholesale
overwrite that deletes TAK-NZ customizations." >/dev/null
    after="$(git rev-parse HEAD^{tree})"

    [ "$before" = "$after" ] || die "seed merge changed file content - this must never happen"

    ok "merge base established at $TARGET (no files changed)"
    echo
    echo "${YEL}IMPORTANT${OFF}: when this lands on main it MUST be merged with a real merge"
    echo "commit. A squash or rebase merge discards the second parent and destroys the"
    echo "ancestry this whole scheme depends on."
    echo
    echo "Next: git push -u origin $VENDOR_BRANCH && git push origin HEAD"
    exit 0
fi

# ---------------------------------------------------------------------------
# Normal sync
# ---------------------------------------------------------------------------
if ! git rev-parse -q --verify "refs/heads/$VENDOR_BRANCH" >/dev/null; then
    if git rev-parse -q --verify "refs/remotes/origin/$VENDOR_BRANCH" >/dev/null; then
        echo "📥 creating local $VENDOR_BRANCH from origin"
        git branch "$VENDOR_BRANCH" "origin/$VENDOR_BRANCH"
    else
        die "$VENDOR_BRANCH does not exist locally or on origin.
   It records which upstream version our tree derives from. Create it with:
     scripts/sync-upstream.sh --seed \$(cat $VERSION_FILE 2>/dev/null || echo '<upstream-tag>')"
    fi
elif git rev-parse -q --verify "refs/remotes/origin/$VENDOR_BRANCH" >/dev/null \
     && git merge-base --is-ancestor "$VENDOR_BRANCH" "origin/$VENDOR_BRANCH" \
     && [ "$(git rev-parse "$VENDOR_BRANCH")" != "$(git rev-parse "origin/$VENDOR_BRANCH")" ]; then
    # CI may have already advanced the vendor branch (it does this even when the
    # merge needs a human). Fast-forward so we don't create a second vendor
    # commit for content that already has one.
    echo "📥 fast-forwarding $VENDOR_BRANCH to origin"
    git update-ref "refs/heads/$VENDOR_BRANCH" "origin/$VENDOR_BRANCH"
fi

# The whole approach hinges on this. If the ancestry is missing git falls back
# to an ancient common ancestor and the merge explodes into ~1200 conflicts
# instead of ~30, so fail here with instructions rather than let that happen.
if ! git merge-base --is-ancestor "$VENDOR_BRANCH" HEAD; then
    die "$VENDOR_BRANCH is not an ancestor of $(git branch --show-current).

   Usually this means a pull request containing the merge-base commit was
   squash- or rebase-merged, which discards the second parent.

   Repair it (changes no files) with:
     git branch -D $VENDOR_BRANCH
     scripts/sync-upstream.sh --seed $(cat "$VERSION_FILE" 2>/dev/null || echo '<last-synced-tag>')"
fi

CURRENT_VERSION="$(cat "$VERSION_FILE" 2>/dev/null || echo 'unknown')"
echo "📌 currently synced: ${CURRENT_VERSION}  ($(git log -1 --format=%h "$VENDOR_BRANCH"))"

if [ "$CURRENT_VERSION" = "$TARGET" ]; then
    ok "already synced to $TARGET - nothing to do"
    exit "$EXIT_UP_TO_DATE"
fi

if [ "$USE_CURRENT_BRANCH" = false ]; then
    SYNC_BRANCH="sync/upstream-$(date +%Y%m%d-%H%M%S)"
    git checkout -q -b "$SYNC_BRANCH"
else
    SYNC_BRANCH="$(git branch --show-current)"
fi
echo "🌿 merging into: $SYNC_BRANCH"

# Advance the vendor branch. Its parent is the previous vendor commit, which is
# what gives git the correct merge base. If the vendor tip already holds exactly
# this upstream content (CI ran ahead of us), reuse it rather than duplicating.
TARGET_TREE="$(build_vendor_tree "$TARGET")"
if [ "$(git rev-parse "$VENDOR_BRANCH^{tree}")" = "$TARGET_TREE" ]; then
    echo "📦 $VENDOR_BRANCH already holds $TARGET"
    NEW_VENDOR="$(git rev-parse "$VENDOR_BRANCH")"
else
    NEW_VENDOR="$(build_vendor_commit "$TARGET" "$(git rev-parse "$VENDOR_BRANCH")")"
    git update-ref "refs/heads/$VENDOR_BRANCH" "$NEW_VENDOR"
    echo -n "📦 upstream delta ${CURRENT_VERSION} -> ${TARGET}:"
    git diff --shortstat "${NEW_VENDOR}^" "$NEW_VENDOR"
fi

if [ "$(git config --get rerere.enabled 2>/dev/null || echo false)" != "true" ]; then
    echo "${DIM}   tip: 'git config rerere.enabled true' makes git replay your conflict"
    echo "   resolutions on future syncs${OFF}"
fi

echo
echo "🔀 merging $VENDOR_BRANCH ..."
MERGE_RC=0
git merge --no-ff --no-commit "$VENDOR_BRANCH" >/dev/null 2>&1 || MERGE_RC=$?

# Record the version we synced to, in the same commit as the merge.
echo "$TARGET" > "$VERSION_FILE"
git add "$VERSION_FILE"

CONFLICTS="$(git diff --name-only --diff-filter=U || true)"

if [ -n "$CONFLICTS" ]; then
    N="$(echo "$CONFLICTS" | grep -c . || true)"
    echo
    warn "$N file(s) need manual resolution - this is expected and is the whole point:"
    echo "   these are the places where upstream and TAK-NZ changed the same code."
    echo
    echo "   ${DIM}both sides changed (real work):${OFF}"
    git status --porcelain | awk '$1=="UU"{printf "     %s\n",$2}'
    ADDED="$(git status --porcelain | awk '$1=="AU"||$1=="UA"{print $2}')"
    if [ -n "$ADDED" ]; then
        echo
        echo "   ${DIM}TAK-NZ-only files upstream relocated (usually just 'git add'):${OFF}"
        echo "$ADDED" | sed 's/^/     /'
    fi
    DELETED="$(git status --porcelain | awk '$1=="UD"||$1=="DU"||$1=="DD"{print $2}')"
    if [ -n "$DELETED" ]; then
        echo
        echo "   ${DIM}deleted on one side - decide whether the customization still applies:${OFF}"
        echo "$DELETED" | sed 's/^/     /'
    fi
    echo
    echo "📋 next steps:"
    echo "   1. Resolve each file. docs/fork/FORK-DELTA.md explains why each TAK-NZ"
    echo "      customization exists, grouped by concern - use it as reference."
    echo "   2. git add <file> ... && git commit      ${DIM}(the merge commit is pre-staged)${OFF}"
    echo "   3. cd api && npm ci && npx tsc --noEmit && cd web && npm ci && npm run lint && npm test"
    echo "   4. git push -u origin $SYNC_BRANCH $VENDOR_BRANCH"
    echo
    echo "   ${YEL}Push $VENDOR_BRANCH too, and merge the PR with a MERGE COMMIT${OFF}"
    echo "   ${YEL}(never squash) or the next sync loses its merge base.${OFF}"
    exit "$EXIT_CONFLICTS"
fi

[ "$MERGE_RC" -eq 0 ] || die "merge failed for a reason other than conflicts (rc=$MERGE_RC)"

git commit --no-edit -m "chore(sync): upstream ${SYNC_PATHS[*]} ${CURRENT_VERSION} -> ${TARGET}" >/dev/null
ok "merged cleanly with no conflicts"

echo
echo "🔍 post-sync validation ${DIM}(advisory - this script hardcodes pre-v13.27 paths)${OFF}"
if ./scripts/post-sync-validate.sh; then
    ok "post-sync validation passed"
else
    warn "post-sync validation reported problems - review them before merging"
fi

echo
echo "📋 next steps:"
echo "   1. cd api && npm ci && npx tsc --noEmit && cd web && npm ci && npm run lint && npm test"
echo "   2. git push -u origin $SYNC_BRANCH $VENDOR_BRANCH"
echo "   3. Open a PR and merge it with a ${YEL}MERGE COMMIT (never squash)${OFF}"
exit "$EXIT_MERGED"
