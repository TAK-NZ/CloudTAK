# ALB OIDC Logout Fix

## Issues Fixed

1. **Removed debug bypass capability** - Removed `ALB_OIDC_SKIP_SIGNATURE_VERIFICATION` environment variable
2. **Fixed logout endpoint** - Properly clears ALB session cookies and redirects to Authentik logout
3. **Fixed frontend logout** - Added proper error handling and token management

## Changes Made

### Backend (`api/routes/login.ts`)

**Logout Endpoint (`GET /api/logout`)**:
- Uses `res.clearCookie()` to delete ALB session cookies (0-4 shards)
- Sets proper cookie options: `path: '/'`, `domain: undefined`
- Returns Authentik logout URL: `${AUTHENTIK_URL}/application/o/${AUTHENTIK_APP_SLUG}/end-session/`
- Follows AWS documentation: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html#authentication-logout

### Frontend (`api/web/src/App.vue`)

**Logout Function**:
- Saves token before deleting from localStorage
- Includes Authorization header in fetch request
- Proper error handling with console logging
- Redirects to returned `logoutUrl` from backend
- Fallback to `/login` if API call fails

### Auth Library (`api/lib/auth.ts`)

**Removed Debug Bypass**:
- Removed `ALB_OIDC_SKIP_SIGNATURE_VERIFICATION` check
- Simplified signature verification flow
- Kept IEEE P1363 signature encoding support for ES256

## How It Works

### Logout Flow

1. **User clicks logout** in frontend
2. **Frontend calls** `GET /api/logout` with Authorization header
3. **Backend clears** ALB session cookies:
   ```javascript
   res.clearCookie('AWSELBAuthSessionCookieCloudTAK-0', { path: '/' });
   res.clearCookie('AWSELBAuthSessionCookieCloudTAK-1', { path: '/' });
   // ... up to -4
   ```
4. **Backend returns** Authentik logout URL
5. **Frontend redirects** to Authentik logout page
6. **Authentik logs out** user and redirects back to application
7. **User sees** login page (no valid session)

### Cookie Deletion

According to AWS documentation, ALB session cookies can be deleted by the application using standard cookie deletion methods:

```javascript
res.clearCookie(`${cookieName}-${i}`, {
    path: '/',
    domain: undefined
});
```

The cookies are named with shards (0, 1, 2, etc.) when the session data is large, so we delete up to 5 shards to ensure complete logout.

## Testing

### Test Logout Flow

1. **Login via SSO**
   - Navigate to CloudTAK
   - Click "Login with SSO"
   - Authenticate with Authentik
   - Verify successful login

2. **Check Session Cookies**
   - Open browser DevTools → Application → Cookies
   - Verify `AWSELBAuthSessionCookieCloudTAK-0` exists
   - Note the cookie value

3. **Logout**
   - Click user menu → Logout
   - Should redirect to Authentik logout page
   - Then redirect back to CloudTAK login page

4. **Verify Cookies Cleared**
   - Check browser cookies again
   - `AWSELBAuthSessionCookieCloudTAK-*` cookies should be gone
   - Verify you cannot access protected pages

5. **Test Re-login**
   - Click "Login with SSO" again
   - Should go through full authentication flow
   - New session cookies should be created

## Troubleshooting

### Cookies Not Being Deleted

**Symptom**: After logout, ALB session cookies still exist

**Possible Causes**:
1. Cookie domain mismatch
2. Cookie path mismatch
3. Cookie name mismatch

**Solution**:
- Check actual cookie name in browser DevTools
- Verify `ALB_AUTH_SESSION_COOKIE` environment variable matches
- Ensure cookie path is `/`
- Check CloudWatch logs for `/api/logout` calls

### Not Redirecting to Authentik

**Symptom**: Logout redirects to `/login` instead of Authentik

**Possible Causes**:
1. `/api/logout` endpoint not being called
2. Environment variables not set
3. OIDC not enabled

**Solution**:
- Check browser Network tab for `/api/logout` request
- Verify `AUTHENTIK_URL` and `AUTHENTIK_APP_SLUG` are set
- Check `ALB_OIDC_ENABLED=true` in environment
- Review CloudWatch logs for errors

### Still Logged In After Logout

**Symptom**: Can still access protected pages after logout

**Possible Causes**:
1. CloudTAK JWT token still in localStorage
2. ALB session cookies not cleared
3. Browser caching

**Solution**:
- Clear browser localStorage manually
- Clear all cookies for the domain
- Hard refresh (Ctrl+Shift+R)
- Check if logout endpoint is being called

## Security Considerations

1. **Cookie Deletion**: Properly clears all ALB session cookie shards
2. **IdP Logout**: Redirects to Authentik to clear IdP session
3. **Token Cleanup**: Frontend removes JWT token from localStorage
4. **No Bypass**: Removed debug bypass capability for production safety

## References

- [AWS ALB Authentication Logout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html#authentication-logout)
- [Express.js clearCookie](https://expressjs.com/en/api.html#res.clearCookie)
- [Authentik End Session](https://docs.goauthentik.io/docs/providers/oauth2/)
