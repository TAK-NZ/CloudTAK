#!/bin/bash

# Pre-Sync Check Script
# This script should be run before syncing with upstream to identify potential conflicts

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_REMOTE="upstream"
UPSTREAM_BRANCH="main"

echo "🔍 Pre-Sync Validation for CloudTAK"
echo "=================================="

# Check if upstream remote exists
if ! git remote | grep -q "^${UPSTREAM_REMOTE}$"; then
    echo "❌ Upstream remote '${UPSTREAM_REMOTE}' not found"
    echo "   Add it with: git remote add ${UPSTREAM_REMOTE} https://github.com/dfpc-coe/CloudTAK.git"
    exit 1
fi

# Fetch latest upstream
echo "📡 Fetching latest upstream changes..."
git fetch ${UPSTREAM_REMOTE} ${UPSTREAM_BRANCH}

# Check for schema differences
echo "🔍 Checking schema differences..."
SCHEMA_DIFF=$(git diff HEAD ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} -- api/lib/schema.ts | wc -l)

if [ "$SCHEMA_DIFF" -gt 0 ]; then
    echo "⚠️  Schema changes detected in upstream:"
    echo "   - Review changes: git diff HEAD ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} -- api/lib/schema.ts"
    echo "   - Check for removed tables that might break imports"
    
    # Extract removed exports
    REMOVED_EXPORTS=$(git diff HEAD ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} -- api/lib/schema.ts | grep "^-export const" | sed 's/^-export const \([A-Za-z0-9_]*\).*/\1/' || true)
    
    if [ -n "$REMOVED_EXPORTS" ]; then
        echo "   - Potentially removed schema exports:"
        echo "$REMOVED_EXPORTS" | sed 's/^/     * /'
        
        echo "   - Checking for usage of removed exports..."
        for export in $REMOVED_EXPORTS; do
            if grep -r "import.*${export}" api/ --include="*.ts" --include="*.js" > /dev/null 2>&1; then
                echo "     ❌ ${export} is still imported in:"
                grep -r "import.*${export}" api/ --include="*.ts" --include="*.js" | sed 's/^/       /'
            fi
        done
    fi
fi

# Check for route file changes
echo "🔍 Checking route file changes..."
ROUTE_CHANGES=$(git diff --name-only HEAD ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} -- api/routes/ | wc -l)

if [ "$ROUTE_CHANGES" -gt 0 ]; then
    echo "⚠️  Route file changes detected:"
    git diff --name-only HEAD ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} -- api/routes/ | sed 's/^/   - /'
fi

# Check for package.json changes
echo "🔍 Checking dependency changes..."
PACKAGE_DIFF=$(git diff HEAD ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} -- api/package.json | wc -l)

if [ "$PACKAGE_DIFF" -gt 0 ]; then
    echo "⚠️  Package.json changes detected - review dependencies"
fi

# Run current validation
echo "🔍 Running current codebase validation..."
if [ -f "${PROJECT_ROOT}/scripts/validate-sync.js" ]; then
    cd "${PROJECT_ROOT}/api" && node ../scripts/validate-sync.js
else
    echo "⚠️  Sync validation script not found"
fi

echo ""
echo "✅ Pre-sync check completed"
echo ""
echo "📋 Next steps:"
echo "   1. Review any warnings above"
echo "   2. Create patches for TAK-NZ specific features if needed"
echo "   3. Run sync: git merge ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
echo "   4. Run post-sync validation: npm run validate:sync"
echo "   5. Test the application thoroughly"