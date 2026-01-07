# Hide Login Form During OIDC Redirects

## Problem

When OIDC forced login is enabled, users briefly see the username/password login form before being redirected to the SSO provider. This causes confusion as users might try to enter credentials when they should be using SSO.

Similarly, when returning from the IdP with a token in the URL, users see the login form flash before being redirected to the application.

## Solution

This patch hides the login form and shows a loading spinner with appropriate messages during OIDC redirects:

1. **OIDC Callback** (`/login?token=xyz`): Shows "Completing login..." instead of form
2. **Forced SSO Redirect**: Shows "Redirecting to SSO..." instead of form
3. **Normal Login**: Shows form as usual

## Changes

### Template Changes
- Form fields wrapped in `v-if` condition to hide during redirects
- Loading message made dynamic based on redirect type

### Script Changes
- Added `loadingMessage` ref for dynamic loading text
- Set `loading = true` when token is in URL
- Set `loading = true` when forcing SSO redirect
- Update loading message appropriately for each scenario

## User Experience

### Before
```
User visits /login
  ↓
Sees username/password form (confusing!)
  ↓
~100-500ms later
  ↓
Redirects to SSO
```

### After
```
User visits /login
  ↓
Sees logo + "Redirecting to SSO..." (clear!)
  ↓
Redirects to SSO immediately
```

## Testing

1. **OIDC Forced Redirect:**
   - Set `OIDC_FORCED=true`
   - Visit `/login`
   - Should see: Logo + "Redirecting to SSO..."
   - Should NOT see: Username/password fields

2. **OIDC Callback:**
   - Login via SSO
   - Return to `/login?token=xyz`
   - Should see: Logo + "Completing login..."
   - Should NOT see: Username/password fields

3. **Local Admin Login:**
   - Visit `/login?local=true`
   - Should see: Username/password form (normal)

4. **Normal Login (OIDC not forced):**
   - Visit `/login`
   - Should see: Username/password form + SSO button

## Benefits

- **Clearer UX**: Users understand they're being redirected
- **No confusion**: Don't see form they can't use
- **Professional**: Smooth transition without form flash
- **Consistent**: Same loading pattern as other parts of app

## Related Patches

- `036-oidc-forced-login.patch` - Implements forced OIDC login
- `013-oidc-login-route.patch` - OIDC login route implementation
