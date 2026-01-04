# Forced OIDC Login Feature

## Overview

This feature allows administrators to enforce OIDC (Single Sign-On) authentication for all users, with an exception for system administrators who can still access the local login form via a special URL parameter.

## Configuration

The feature is controlled by the `oidcForced` configuration option in `cdk.json`:

```json
{
  "context": {
    "dev-test": {
      "cloudtak": {
        "oidcEnabled": true,
        "oidcForced": true
      }
    }
  }
}
```

### Configuration Options

- **`oidcForced: true`** (default): Forces all non-system-admin users to use OIDC login
- **`oidcForced: false`**: Allows both local and OIDC login for all users (traditional behavior)

## Behavior

### When `oidcForced` is `true`:

1. **Regular Users**:
   - Accessing `/login` automatically redirects to the OIDC provider (Authentik)
   - Cannot access the local login form
   - Attempting to login via API with local credentials returns a 403 error

2. **System Administrators**:
   - Can access the local login form by visiting `/login?local=true`
   - Can authenticate using their local username and password
   - This provides a fallback mechanism in case of OIDC provider issues

3. **Error Handling**:
   - If a non-system-admin attempts to login locally, they receive an error message: "Local login is restricted. Please use SSO."
   - The frontend automatically redirects them to the OIDC login flow

### When `oidcForced` is `false`:

- All users can choose between local login and OIDC login
- The login page displays both options
- No automatic redirects occur

## Implementation Details

### Backend Changes

1. **Environment Variable**: `OIDC_FORCED` is set based on the CDK configuration
2. **Login Route** (`api/routes/login.ts`):
   - Checks if OIDC is forced before processing local login
   - Validates that the user is a system admin if OIDC is forced
   - Returns 403 error for non-system-admins attempting local login

3. **Auth Library** (`api/lib/auth.ts`):
   - `isOidcForced()` function checks the `OIDC_FORCED` environment variable

4. **Server Route** (`api/routes/server.ts`):
   - `/api/server/oidc` endpoint returns `oidc_forced` status to the frontend

### Frontend Changes

1. **Login Component** (`api/web/src/components/Login.vue`):
   - Checks `oidc_forced` status on mount
   - Automatically redirects to OIDC if forced (unless `?local=true` is present)
   - Handles 403 errors by redirecting to OIDC login
   - Adds `oidcForced` reactive variable to track state

### CDK Changes

1. **Stack Configuration** (`cdk/lib/stack-config.ts`):
   - Added `oidcForced?: boolean` to the `cloudtak` configuration interface

2. **CloudTAK API Construct** (`cdk/lib/constructs/cloudtak-api.ts`):
   - Passes `OIDC_FORCED` environment variable to the ECS container
   - Defaults to `true` if not explicitly set to `false`

## Use Cases

### Primary Use Case: Enforce SSO for Security

Organizations that want to:
- Centralize authentication through their identity provider
- Enforce multi-factor authentication via OIDC
- Maintain audit trails through the identity provider
- Disable local password management

### Emergency Access

System administrators can still access the system via `/login?local=true` in case:
- The OIDC provider is down
- There are configuration issues with OIDC
- Emergency maintenance is required

## Security Considerations

1. **System Admin Verification**: The backend validates that users attempting local login are actually system administrators by checking the database
2. **No Bypass**: Non-system-admins cannot bypass the OIDC requirement, even with the `?local=true` parameter
3. **Error Messages**: Error messages are generic to avoid information disclosure
4. **Automatic Redirect**: Failed local login attempts automatically redirect to OIDC

## Testing

### Test Forced OIDC (System Admin)

1. Set `oidcForced: true` in `cdk.json`
2. Deploy the stack
3. Visit `/login?local=true`
4. Login with system admin credentials
5. Should successfully authenticate

### Test Forced OIDC (Regular User)

1. Set `oidcForced: true` in `cdk.json`
2. Deploy the stack
3. Visit `/login`
4. Should automatically redirect to OIDC provider
5. Attempting to access `/login?local=true` with non-admin credentials should redirect to OIDC

### Test Optional OIDC

1. Set `oidcForced: false` in `cdk.json`
2. Deploy the stack
3. Visit `/login`
4. Should see both local login form and SSO button
5. Both authentication methods should work

## Related Patches

- `011-oidc-auth-lib.patch` - OIDC authentication library
- `013-oidc-login-route.patch` - OIDC login route
- `016-oidc-login-component.patch` - OIDC login component
- `036-oidc-forced-login.patch` - This feature (forced OIDC)

## Migration Notes

When upgrading from a version without this feature:
- The default value is `true` for `oidcForced`
- Existing deployments with `oidcEnabled: true` will automatically enforce OIDC
- To maintain the old behavior, explicitly set `oidcForced: false`
