# Admin Environment Variables Patch

## Overview

This patch adds support for creating the initial CloudTAK admin user via environment variables instead of requiring manual configuration through the UI.

## Feature

Allows setting admin credentials via environment variables:
- `CLOUDTAK_ADMIN_USERNAME` - Admin email address
- `CLOUDTAK_ADMIN_PASSWORD` - Admin password

## Source

Based on upstream PR #752: https://github.com/dfpc-coe/CloudTAK/pull/752

This PR has not yet been merged into dfpc-coe/CloudTAK upstream.

## Files Modified

- `api/lib/config.ts` - Adds environment variable support for admin user creation

## Application

This patch is applied automatically by `scripts/apply-patches.sh` after syncing with upstream.

## Manual Application

```bash
cd /home/ubuntu/GitHub/TAK-NZ/CloudTAK
git apply scripts/patches/000-admin-env-vars-config.patch
```

## When PR #752 Merges

Once PR #752 is merged into upstream, this patch can be removed as the functionality will be included in the base CloudTAK code.

## Related

- Upstream PR: #752 (pending merge)
- Previous branch: `origin/takserver-config-env` (deprecated)
- TAK-NZ specific until upstream merge
