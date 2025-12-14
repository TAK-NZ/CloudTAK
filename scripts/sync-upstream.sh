#!/bin/bash

set -e

echo "🔄 Syncing CloudTAK api/tasks from upstream..."

# Parse command line arguments
USE_CURRENT_BRANCH=false
TARGET_REF="upstream/main"

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

# Function to sync directory with proper deletion handling
sync_directory() {
    local dir=$1
    local target_ref=$2
    
    echo "📂 Syncing $dir/ folder from $target_ref..."
    
    # Get list of files that exist in upstream
    echo "   📋 Getting upstream file list..."
    UPSTREAM_FILES=$(git ls-tree -r --name-only $target_ref $dir/ 2>/dev/null || true)
    
    # Get list of git-tracked files that exist locally
    LOCAL_FILES=$(git ls-files $dir/ 2>/dev/null | sort || true)
    
    # Checkout all files from upstream (this handles updates and additions)
    if [ -n "$UPSTREAM_FILES" ]; then
        echo "   ⬇️  Checking out files from upstream..."
        git checkout $target_ref -- $dir/ 2>/dev/null || true
    fi
    
    # Find and remove files that exist locally but not in upstream
    if [ -n "$LOCAL_FILES" ] && [ -n "$UPSTREAM_FILES" ]; then
        echo "   🗑️  Checking for files to remove..."
        
        # Create temporary files for comparison
        echo "$UPSTREAM_FILES" | sort > /tmp/upstream_files.txt
        echo "$LOCAL_FILES" | sort > /tmp/local_files.txt
        
        # Find files that exist locally but not upstream
        FILES_TO_DELETE=$(comm -23 /tmp/local_files.txt /tmp/upstream_files.txt || true)
        
        if [ -n "$FILES_TO_DELETE" ]; then
            echo "   ❌ Removing files that were deleted upstream:"
            echo "$FILES_TO_DELETE" | while read -r file; do
                # Skip Dockerfiles - keep local versions
                if [[ "$file" == *"/Dockerfile" ]]; then
                    echo "      ⏭️  Skipping $file (keeping local version)"
                    continue
                fi
                if [ -f "$file" ]; then
                    echo "      - $file"
                    rm "$file"
                    git add "$file" 2>/dev/null || true
                fi
            done
        else
            echo "   ✅ No files to remove"
        fi
        
        # Clean up temp files
        rm -f /tmp/upstream_files.txt /tmp/local_files.txt
    fi
}

# Sync directories with deletion handling
sync_directory "api" "$TARGET_REF"
sync_directory "tasks" "$TARGET_REF"

# No additional patching or branding needed
echo "📝 Changes ready for review (branding applied at build time)"

# Clean up upstream remote if we added it
if [[ "$ADDED_UPSTREAM" == "true" ]]; then
    echo "🧹 Removing temporary upstream remote..."
    git remote remove upstream
fi

echo "✅ Sync complete!"

# Run post-sync validation
echo ""
echo "🔍 Running post-sync validation..."
if ./scripts/post-sync-validate.sh; then
    echo "✅ Post-sync validation passed"
else
    echo "❌ Post-sync validation failed"
    echo "   Please fix the issues above before proceeding"
    exit 1
fi

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