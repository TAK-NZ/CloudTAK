#!/bin/bash

set -e

echo "🎨 Applying TAK.NZ branding..."

# Replace logos if they exist
if [ -f "branding/logo/tak-nz-logo.svg" ] && [ -d "api/web/public" ]; then
    if command -v rsvg-convert &> /dev/null; then
        rsvg-convert -w 1000 branding/logo/tak-nz-logo.svg > api/web/public/logo.png 
        echo "✅ Updated logo.png"
    else
        echo "⚠️  rsvg-convert not available, skipping logo conversion"
    fi
    
    # Update CloudTAKLogo.svg with TAK.NZ logo
    cp branding/logo/tak-nz-logo.svg api/web/public/CloudTAKLogo.svg
    echo "✅ Updated CloudTAKLogo.svg"
fi

if [ -f "branding/logo/favicon.ico" ] && [ -d "api/web/public" ]; then
    cp branding/logo/favicon.ico api/web/public/favicon.ico
    echo "✅ Updated favicon.ico"
fi

if [ -f "branding/logo/icons.ts" ] && [ -d "api/web/public/logos" ]; then
    cp branding/logo/icons.ts api/web/public/logos/icons.ts
    echo "✅ Updated icons.ts"
fi

# Generate icons if script exists
if [ -f "branding/generate_icons.sh" ]; then
    branding/generate_icons.sh
fi

# Replace branding text
if [ -f "api/web/src/App.vue" ]; then
    sed -i.bak "s/Colorado - DFPC - CoE/TAK.NZ \\&bull; Team Awareness \\&bull; Te mōhio o te rōpū/g" api/web/src/App.vue
    echo "✅ Updated App.vue branding"
fi

# Add security headers to nginx configuration
if [ -f "api/nginx.conf.js" ]; then
    # Create temporary file with headers to add
    cat > /tmp/tak_headers.txt << 'EOF'
        add_header 'Reporting-Endpoints' 'default="https://tak-nz.uriports.com/reports"' always;
        add_header 'Report-To' '{"group":"default","max_age":10886400,"endpoints":[{"url":"https://tak-nz.uriports.com/reports"}],"include_subdomains":true}' always;
        add_header 'NEL' '{"report_to":"default","max_age":2592000,"include_subdomains":true,"failure_fraction":1.0}' always;
        add_header 'Permissions-Policy-Report-Only' 'microphone=();report-to=default, camera=(self "https://www.example.com");report-to=default, fullscreen=*;report-to=default, payment=self;report-to=default' always;
        add_header 'Content-Security-Policy-Report-Only' "default-src 'self'; font-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; style-src-attr 'self' 'unsafe-inline'; connect-src 'self' *.test.tak.nz *.map.test.tak.nz; worker-src 'self' blob:; frame-ancestors 'self'; report-uri https://tak-nz.uriports.com/reports/report; report-to default" always;
EOF
    
    # Add headers after the Permissions-Policy line
    sed -i.bak "/add_header 'Permissions-Policy'/r /tmp/tak_headers.txt" api/nginx.conf.js
    rm /tmp/tak_headers.txt
    echo "✅ Added TAK.NZ security headers to nginx configuration"
fi

echo "🎉 TAK.NZ branding applied successfully"