#!/bin/bash

set -e

echo "🎨 Applying TAK.NZ branding..."

# Replace logos if they exist
if [ -f "branding/logo/tak-nz-logo.svg" ] && [ -d "app/public" ]; then
    if command -v rsvg-convert &> /dev/null; then
        rsvg-convert -w 1000 branding/logo/tak-nz-logo.svg > app/public/logo.png 
        echo "✅ Updated logo.png"
    else
        echo "⚠️  rsvg-convert not available, skipping logo conversion"
    fi
    
    # Update CloudTAKLogo.svg with TAK.NZ logo
    cp branding/logo/tak-nz-logo.svg app/public/CloudTAKLogo.svg
    echo "✅ Updated CloudTAKLogo.svg"
fi

if [ -f "branding/logo/favicon.ico" ] && [ -d "app/public" ]; then
    cp branding/logo/favicon.ico app/public/favicon.ico
    echo "✅ Updated favicon.ico"
fi

if [ -f "branding/logo/icons.ts" ] && [ -d "app/public/logos" ]; then
    cp branding/logo/icons.ts app/public/logos/icons.ts
    echo "✅ Updated icons.ts"
fi

# Generate icons if script exists
if [ -f "branding/generate_icons.sh" ]; then
    branding/generate_icons.sh
fi

# Replace branding text
if [ -f "app/src/App.vue" ]; then
    sed -i.bak "s/Colorado - DFPC - CoE/TAK.NZ \\&bull; Team Awareness \\&bull; Te mōhio o te rōpū/g" app/src/App.vue
    echo "✅ Updated App.vue branding"
fi

# Replace AWS branding with CloudTAK logo in Login.vue
if [ -f "app/src/components/Login.vue" ]; then
    sed -i.bak "s|height: 72px;|height: 48px;|g" app/src/components/Login.vue
    sed -i.bak "s|src='/powered-by-aws-white.png'|src='/CloudTAKLogoText.svg'|g" app/src/components/Login.vue
    sed -i.bak "s|alt='Powered by AWS'|alt='CloudTAK Logo'|g" app/src/components/Login.vue
    echo "✅ Updated Login.vue AWS branding"
fi

echo "🎉 TAK.NZ branding applied successfully"