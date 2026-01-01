# OIDC Authentication Patches

This directory contains Git patches for the OIDC authentication implementation. These patches should be applied after syncing with upstream CloudTAK to restore TAK.NZ-specific OIDC functionality.

## Patches

### Backend (API)

1. **011-oidc-auth-lib.patch** - `api/lib/auth.ts`
   - Adds `oidcParser()` function to parse ALB OIDC headers
   - Adds `isOidcEnabled()` helper function
   - Feature flag controlled via `ALB_OIDC_ENABLED` environment variable

2. **012-oidc-auth-parser.patch** - `api/lib/auth.ts`
   - Implements JWT signature verification using ALB public keys
   - Handles ES256 algorithm with IEEE P1363 encoding
   - Validates token expiration and issuer

3. **013-oidc-login-route.patch** - `api/routes/login.ts`
   - Adds GET `/api/login/oidc` endpoint
   - Auto-creates users on first OIDC login
   - **Automatic certificate enrollment**:
     - Gets Authentik API token from Secrets Manager
     - Creates application password in Authentik
     - Requests certificate from TAK Server
     - Stores certificate in user profile
   - Generates JWT token and redirects to frontend
   - Includes helper functions: `getAuthentikToken()` and `createAuthentikAppPassword()`

4. **014-oidc-server-route.patch** - `api/routes/server.ts`
   - Adds GET `/api/server/oidc` public endpoint
   - Returns `oidc_enabled` and `authentik_url`
   - Adds `oidc_enabled` field to all `/api/server` responses

5. **015-oidc-types.patch** - `api/lib/types.ts`
   - Adds `oidc_enabled: Type.Boolean()` to ServerResponse type

### Frontend

6. **016-oidc-login-component.patch** - `api/web/src/components/Login.vue`
   - Adds "Login with SSO" button (conditionally displayed)
   - Handles token from OIDC redirect in URL query params
   - Checks OIDC status via `/api/server/oidc` endpoint
   - Redirects to `/api/login/oidc` on SSO button click
   - Imports IconKey from @tabler/icons-vue

7. **017-oidc-logout-route.patch** - `api/routes/login.ts`
   - Adds GET `/api/logout` endpoint
   - Sets ALB cookie expiration to -1 (clears cookies)
   - Redirects to Authentik end-session endpoint
   - Follows AWS ALB logout documentation

8. **018-oidc-app-logout.patch** - `api/web/src/App.vue`
   - Updates logout function to redirect to `/api/logout`
   - Clears localStorage token before redirect

9. **019-oidc-mainmenu-logout.patch** - `api/web/src/components/CloudTAK/MainMenuContents.vue`
   - Updates MainMenu logout function to redirect to `/api/logout`
   - Clears localStorage token before redirect

## Applying Patches

After syncing with upstream, apply patches in order:

```bash
# Navigate to CloudTAK root
cd /home/ubuntu/GitHub/TAK-NZ/CloudTAK

# Apply all patches in order
for patch in scripts/patches/01*-oidc-*.patch; do
    echo "Applying $patch..."
    git apply "$patch" || echo "Failed to apply $patch"
done
```

## Verifying Patches

After applying patches, verify:

```bash
# Check that files were modified
git status

# Review changes
git diff

# Test compilation
cd api && npm run build
cd ../api/web && npm run build
```

## Dependencies

The OIDC implementation requires these npm packages (should already be in package.json):

### Backend (`api/package.json`)
- `@tak-ps/node-tak` - TAK Server API client
- `@aws-sdk/client-secrets-manager` - AWS Secrets Manager
- `axios` - HTTP client for Authentik API

### Frontend (`api/web/package.json`)
- `@tabler/icons-vue` - Icon library (IconKey)

## Environment Variables

After applying patches, ensure these environment variables are set (handled by CDK):

- `ALB_OIDC_ENABLED="true"` - Enable OIDC feature
- `AUTHENTIK_URL="https://account.test.tak.nz"` - Authentik instance URL
- `AUTHENTIK_API_TOKEN_SECRET_ARN="arn:aws:..."` - Secret ARN for Authentik API token

## Related Files (Not Patched)

These files are TAK.NZ-specific and won't conflict with upstream:

- `cdk/lib/stack-config.ts` - Configuration types
- `cdk/lib/constructs/load-balancer.ts` - ALB OIDC listener
- `cdk/lib/constructs/cloudtak-api.ts` - Environment variables
- `cdk/lib/cloudtak-stack.ts` - OIDC setup integration
- `cdk/lib/constructs/cloudtak-oidc-setup.ts` - Authentik automation
- `cdk/src/cloudtak-oidc-setup/` - Lambda function
- `docs/OIDC_AUTHENTICATION.md` - Documentation

## Troubleshooting

### Patch Fails to Apply

If a patch fails due to upstream changes:

1. Check the rejected hunks in `.rej` files
2. Manually apply the changes
3. Regenerate the patch:
   ```bash
   git diff HEAD -- <file> > scripts/patches/01X-oidc-<name>.patch
   ```

### Merge Conflicts

If upstream modified the same code:

1. Apply patch with 3-way merge:
   ```bash
   git apply --3way scripts/patches/01X-oidc-<name>.patch
   ```
2. Resolve conflicts manually
3. Update patch if needed

## Documentation

See `docs/OIDC_AUTHENTICATION.md` for complete implementation details and `UPSTREAM-FEATURE-REQUEST.md` for the feature request to submit upstream.
