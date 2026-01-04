# Admin Environment Variables Patch

## Overview

This patch adds support for creating the initial CloudTAK admin user via environment variables instead of requiring manual configuration through the UI.

## Feature

Allows setting admin credentials via environment variables:
- `CLOUDTAK_ADMIN_USERNAME` - Admin email address
- `CLOUDTAK_ADMIN_PASSWORD` - Admin password

## Source

Based on upstream PR #712 from the `takserver-config-env` branch, which was never merged into dfpc-coe/CloudTAK upstream.

## Files Modified

- `api/lib/config.ts` - Adds environment variable support for admin user creation

## Application

This patch is applied automatically by `scripts/sync-upstream.sh` after syncing with upstream.

## Manual Application

```bash
cd /home/ubuntu/GitHub/TAK-NZ/CloudTAK
git apply scripts/patches/037-admin-env-vars-config.patch
```

## Related

- Original branch: `origin/takserver-config-env`
- Upstream PR: #712 (not merged)
- TAK-NZ specific feature
