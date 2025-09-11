#!/bin/bash

set -e

echo "🎨 Applying TAK.NZ customization patches..."

PATCHES_DIR="$(dirname "$0")/patches"

if [ ! -d "$PATCHES_DIR" ]; then
    echo "❌ Patches directory not found: $PATCHES_DIR"
    exit 1
fi

# Apply all patches in order
for patch in "$PATCHES_DIR"/*.patch; do
    if [ -f "$patch" ]; then
        echo "📝 Applying $(basename "$patch")..."
        if git apply "$patch"; then
            echo "✅ Successfully applied $(basename "$patch")"
        else
            echo "❌ Failed to apply $(basename "$patch")"
            echo "💡 You may need to resolve conflicts manually"
            exit 1
        fi
    fi
done

echo "✅ All patches applied successfully!"