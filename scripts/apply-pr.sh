#!/bin/bash

set -e

SKIP_FILES=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-files)
            IFS=',' read -ra SKIP_FILES <<< "$2"
            shift 2
            ;;
        *)
            PR_NUMBER=$1
            shift
            ;;
    esac
done

if [[ -z "$PR_NUMBER" ]]; then
    echo "Usage: $0 <PR_NUMBER> [--skip-files file1,file2,...]"
    echo "Example: $0 712 --skip-files docs/ENVIRONMENT_VARIABLES.md"
    exit 1
fi

echo "🔄 Applying commits from PR #$PR_NUMBER..."

# Check if upstream remote exists
ADDED_UPSTREAM=false
if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "❌ Upstream remote not found. Adding dfpc-coe/CloudTAK as upstream..."
    git remote add upstream https://github.com/dfpc-coe/CloudTAK.git
    ADDED_UPSTREAM=true
fi

# Fetch upstream branches and PR
echo "📡 Fetching upstream and PR #$PR_NUMBER..."
git fetch upstream
git fetch upstream pull/$PR_NUMBER/head:pr-$PR_NUMBER

# Get the base branch (usually main)
BASE_BRANCH=$(git show-branch --merge-base HEAD upstream/main)
echo "📍 Base branch: $BASE_BRANCH"

# Get all commits in the PR
echo "📋 Commits in PR #$PR_NUMBER:"
git log --oneline upstream/main..pr-$PR_NUMBER

echo ""
read -p "Apply these commits? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Cancelled"
    git branch -D pr-$PR_NUMBER 2>/dev/null || true
    exit 1
fi

# Apply commits from the PR
echo "🔀 Applying commits..."
if [[ ${#SKIP_FILES[@]} -gt 0 ]]; then
    echo "📋 Skipping files: ${SKIP_FILES[*]}"
    # Use interactive cherry-pick to handle conflicts
    git cherry-pick upstream/main..pr-$PR_NUMBER || {
        # Remove skipped files if they cause conflicts
        for file in "${SKIP_FILES[@]}"; do
            if git status --porcelain | grep -q "$file"; then
                echo "🗑️  Removing conflicted file: $file"
                git rm "$file" 2>/dev/null || git add "$file"
            fi
        done
        git cherry-pick --continue
    }
else
    git cherry-pick upstream/main..pr-$PR_NUMBER
fi

# Clean up
git branch -D pr-$PR_NUMBER
echo "🧹 Removing upstream remote..."
git remote remove upstream

echo "✅ PR #$PR_NUMBER commits applied successfully!"