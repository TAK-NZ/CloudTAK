#!/bin/bash

# Script to generate icons from SVG based on icons.ts configuration
# Usage: ./generate_icons.sh

ICONS_FILE="api/web/public/logos/icons.ts"
SVG_SOURCE="branding/logo/tak-nz-logo.svg"
BASE_OUTPUT_DIR="api/web/public"

# Check if required files exist
if [ ! -f "$ICONS_FILE" ]; then
    echo "Error: $ICONS_FILE not found"
    exit 1
fi

if [ ! -f "$SVG_SOURCE" ]; then
    echo "Error: $SVG_SOURCE not found"
    exit 1
fi

if ! command -v rsvg-convert &> /dev/null; then
    echo "Error: rsvg-convert not found (install librsvg2-bin)"
    exit 1
fi

if ! command -v convert &> /dev/null; then
    echo "Error: convert not found (install imagemagick)"
    exit 1
fi

# Function to extract width from size string (e.g., "48x48" -> "48")
get_width() {
    local size="$1"
    echo "$size" | cut -d'x' -f1
}

# Function to extract height from size string (e.g., "48x48" -> "48")
get_height() {
    local size="$1"
    echo "$size" | cut -d'x' -f2
}

# Parse the icons.ts file and extract src and sizes
echo "Parsing $ICONS_FILE..."

# Use grep and sed to extract the icon data
grep -E '(src|sizes)' "$ICONS_FILE" | \
sed 's/.*"src": "\([^"]*\)".*/src:\1/' | \
sed 's/.*"sizes": "\([^"]*\)".*/sizes:\1/' | \
while IFS= read -r line; do
    if [[ $line == src:* ]]; then
        current_src="${line#src:}"
    elif [[ $line == sizes:* ]]; then
        current_sizes="${line#sizes:}"
        
        # Extract width and height
        width=$(get_width "$current_sizes")
        height=$(get_height "$current_sizes")
        
        # Convert /logos path to actual file path
        output_path="${BASE_OUTPUT_DIR}${current_src}"
        
        # Create directory if it doesn't exist
        output_dir=$(dirname "$output_path")
        mkdir -p "$output_dir"
        
        # Generate the icon
        echo "Generating: $output_path (${width}x${height})"

        # The source SVG's viewBox isn't perfectly square (1024x1039.657).
        # Passing only -w (as before) let rsvg-convert derive height from
        # the source ratio, silently producing e.g. a 512x520 image for a
        # "512x512" icon slot - every generated icon was slightly squashed.
        #
        # Fix: render with --keep-aspect-ratio (-a), which scales the logo
        # to fit within the target box without distortion, then pad the
        # result onto a transparent canvas of the exact target size with
        # ImageMagick. This guarantees the output canvas always matches the
        # size declared in icons.ts, for both square and non-square targets
        # (e.g. Windows tile logos).
        rm -f "$output_path"
        rsvg-convert -w "$width" -h "$height" -a "$SVG_SOURCE" | \
            convert - -background none -gravity center -extent "${width}x${height}" "$output_path"

        # This inner pipeline runs inside an outer `... | while` pipeline, so
        # PIPESTATUS here would reflect the outer pipeline's stages, not
        # rsvg-convert/convert. Check the output file was actually written
        # instead.
        if [ -s "$output_path" ]; then
            echo "✓ Successfully generated: $output_path"
        else
            echo "✗ Failed to generate: $output_path"
        fi
    fi
done

echo "Icon generation complete!"