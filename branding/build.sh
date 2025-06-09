#!/bin/bash

# Reset the repository to match the remote branch (this will discard local changes to tracked files)
git reset --hard origin/main

# Pull the latest changes
git pull origin main

# Replace the logos
rsvg-convert -w 1000 branding/logo/tak-nz-logo.svg > api/web/public/logo.png 
cp branding/logo/favicon.ico api/web/public/favicon.ico
cp branding/logo/icons.ts api/web/public/logos/icons.ts
branding/generate_icons.sh

# Replace the text
sed -i.orig "s/Colorado - DFPC - CoE/TAK.NZ &bull; Team Awareness &bull; Te mōhio o te rōpū/g" api/web/src/App.vue

# Replace build script
cp branding/js/build.js bin/build.js

# Update the NPM packages
npm update
cd api/web
npm update
cd ../..

# Build the project
export GITSHA=$(git rev-parse HEAD)
export AWS_REGION=ap-southeast-2
export AWS_PROFILE=syd
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query 'Account' --output text 2>/dev/null)
npm run build

npx deploy update devtest --profile syd --region ap-southeast-2
