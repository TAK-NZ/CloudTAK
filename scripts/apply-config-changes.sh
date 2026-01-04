#!/bin/bash

set -e

echo "📄 Applying admin environment variables patch..."
echo "⚠️  Note: This is now handled automatically by sync-upstream.sh"
echo ""

# Apply the patch
git apply scripts/patches/037-admin-env-vars-config.patch

echo "✅ Patch applied!"
echo ""
echo "📋 This script is kept for manual patch application if needed."
echo "   During normal upstream syncs, use: ./scripts/sync-upstream.sh"