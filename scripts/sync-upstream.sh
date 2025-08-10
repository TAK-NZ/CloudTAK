#!/bin/bash

set -e

echo "🔄 Syncing CloudTAK api/tasks from upstream..."

# Parse command line arguments
USE_CURRENT_BRANCH=false
TARGET_REF="main"

while [[ $# -gt 0 ]]; do
    case $1 in
        --current-branch)
            USE_CURRENT_BRANCH=true
            echo "📍 Syncing on current branch"
            shift
            ;;
        --tag|--release)
            TARGET_REF="$2"
            echo "🏷️  Syncing from tag/release: $TARGET_REF"
            shift 2
            ;;
        *)
            echo "❌ Unknown option: $1"
            echo "Usage: $0 [--current-branch] [--tag|--release <tag>]"
            exit 1
            ;;
    esac
done

# Check if upstream remote exists
ADDED_UPSTREAM=false
if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "❌ Upstream remote not found. Adding dfpc-coe/CloudTAK as upstream..."
    git remote add upstream https://github.com/dfpc-coe/CloudTAK.git
    ADDED_UPSTREAM=true
fi

# Fetch latest from upstream
echo "📡 Fetching from upstream..."
git fetch upstream

# Create temporary branch for sync (unless using current branch)
if [[ "$USE_CURRENT_BRANCH" == "false" ]]; then
    SYNC_BRANCH="sync-upstream-$(date +%Y%m%d-%H%M%S)"
    git checkout -b "$SYNC_BRANCH"
else
    SYNC_BRANCH=$(git branch --show-current)
    echo "📍 Using current branch: $SYNC_BRANCH"
fi

# Sync only api and tasks folders
echo "📂 Syncing api/ folder from $TARGET_REF..."
git checkout $TARGET_REF -- api/

echo "📂 Syncing tasks/ folder from $TARGET_REF..."
git checkout $TARGET_REF -- tasks/

# No additional patching or branding needed
echo "📝 Changes ready for review (branding applied at build time)"

# Clean up upstream remote if we added it
if [[ "$ADDED_UPSTREAM" == "true" ]]; then
    echo "🧹 Removing temporary upstream remote..."
    git remote remove upstream
fi

echo "✅ Sync complete!"
echo ""
if [[ "$USE_CURRENT_BRANCH" == "false" ]]; then
    echo "📋 Next steps:"
    echo "   1. Review changes: git diff HEAD~1"
    echo "   2. Test locally: docker-compose up"
    echo "   3. Commit changes: git add . && git commit -m 'Sync api/tasks from upstream $TARGET_REF'"
    echo "   4. Merge to main: git checkout main && git merge $SYNC_BRANCH"
    echo "   5. Deploy: ./scripts/deploy.sh"
else
    echo "📋 Next steps:"
    echo "   1. Review changes: git status"
    echo "   2. Test locally: docker-compose up"
    echo "   3. Commit changes: git add . && git commit -m 'Sync api/tasks from upstream $TARGET_REF'"
    echo "   4. Deploy: ./scripts/deploy.sh"
fi