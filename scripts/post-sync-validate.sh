#!/bin/bash

# Post-Sync Validation Script
# Run this after syncing with upstream to catch common issues

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🔍 Post-Sync Validation"
echo "======================"

# Check for TypeScript compilation errors
echo "📝 Checking TypeScript compilation..."
cd "${PROJECT_ROOT}/api"

if npx tsc --noEmit --skipLibCheck 2>/dev/null; then
    echo "✅ TypeScript compilation passed"
else
    echo "❌ TypeScript compilation failed"
    echo "   Run: cd api && npx tsc --noEmit to see errors"
    exit 1
fi

# Check for missing imports
echo "🔍 Checking for missing schema imports..."
MISSING_IMPORTS=$(grep -r "import.*from.*schema\.js" . --include="*.ts" --include="*.js" | \
    grep -o "{[^}]*}" | \
    tr ',' '\n' | \
    sed 's/[{}]//g' | \
    sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
    grep -v '^$' | \
    sort -u | \
    while read import; do
        if ! grep -q "export const $import" lib/schema.ts; then
            echo "$import"
        fi
    done)

if [ -n "$MISSING_IMPORTS" ]; then
    echo "❌ Missing schema exports:"
    echo "$MISSING_IMPORTS" | sed 's/^/   - /'
    echo "   These imports exist in route files but not in schema.ts"
    exit 1
else
    echo "✅ All schema imports are valid"
fi

# Check for orphaned route files
echo "🔍 Checking for orphaned route files..."
cd routes/
ROUTE_FILES=$(ls *.ts 2>/dev/null | sed 's/\.ts$//' || true)

if [ -n "$ROUTE_FILES" ]; then
    ORPHANED_ROUTES=""
    for route in $ROUTE_FILES; do
        if ! grep -q "$route" ../index.ts; then
            ORPHANED_ROUTES="$ORPHANED_ROUTES\n   - $route.ts"
        fi
    done
    
    if [ -n "$ORPHANED_ROUTES" ]; then
        echo "⚠️  Potentially orphaned route files:"
        echo -e "$ORPHANED_ROUTES"
        echo "   Check if these routes are properly imported in index.ts"
    else
        echo "✅ All route files appear to be imported"
    fi
fi

cd "$PROJECT_ROOT"

# Test basic API startup
echo "🚀 Testing API startup..."
cd api

# Create a minimal test to check if the API can start
cat > test-startup.js << 'EOF'
import('./index.js').then(() => {
    console.log('✅ API startup test passed');
    process.exit(0);
}).catch((err) => {
    console.error('❌ API startup test failed:', err.message);
    process.exit(1);
});
EOF

if timeout 30s node test-startup.js 2>/dev/null; then
    echo "✅ API startup test passed"
else
    echo "❌ API startup test failed"
    echo "   The API may have import or initialization errors"
fi

# Clean up
rm -f test-startup.js

echo ""
echo "✅ Post-sync validation completed"
echo ""
echo "💡 If any issues were found:"
echo "   1. Fix missing schema exports or remove orphaned imports"
echo "   2. Remove orphaned route files or ensure they're imported"
echo "   3. Run validation again: ./scripts/post-sync-validate.sh"