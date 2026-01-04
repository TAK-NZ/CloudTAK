# Feature Request: ALB OIDC Authentication for CloudTAK

## Summary

Add support for AWS Application Load Balancer (ALB) OIDC authentication to CloudTAK, enabling Single Sign-On (SSO) integration with enterprise identity providers. This feature includes automatic X.509 certificate enrollment for seamless user onboarding.

**Reference Implementation**: This feature has been successfully implemented and is available at https://github.com/TAK-NZ/CloudTAK/tree/alb-oidc

## User Interface

The SSO login button appears on the CloudTAK login page when OIDC is enabled:

![CloudTAK Login with SSO](docs/images/cloudtak-login-sso.png)

*Screenshot shows the TAK.NZ CloudTAK login screen with "Login with SSO" button enabled alongside traditional username/password login.*

### Authentik Integration

CloudTAK appears as an application in the Authentik user dashboard:

![CloudTAK in Authentik](docs/images/cloudtak-authentik-app.png)

*Screenshot shows the CloudTAK application tile in Authentik's application dashboard, automatically configured during deployment.*

# Upstream Feature Request: OIDC Authentication via ALB

## Motivation

Enterprise deployments require centralized authentication through identity providers (Authentik, Okta, Azure AD, etc.) rather than managing separate credentials in each application. CloudTAK's requirement for X.509 certificates makes SSO integration more complex than typical web applications.

### Why This Matters

1. **Enterprise SSO**: Organizations need CloudTAK to integrate with their existing identity infrastructure
2. **Simplified Management**: Centralized user provisioning, deprovisioning, and access control
3. **Enhanced Security**: Leverage IdP security features (MFA, conditional access, audit logging)
4. **Seamless Onboarding**: Users authenticate once and immediately have full CloudTAK access

## Implementation Overview

This feature enables OIDC authentication via AWS Application Load Balancer (ALB), which handles the OAuth2/OIDC flow and passes authenticated user information to CloudTAK via HTTP headers.

### Architecture

```
User → ALB OIDC → Identity Provider → ALB (validates) → CloudTAK Backend
                                                              ↓
                                                    Extract email from x-amzn-oidc-data header
                                                              ↓
                                                    Auto-create user profile (if new)
                                                              ↓
                                                    Generate JWT token
                                                              ↓
                                                    Redirect to frontend with token
```

### Benefits

- Works with any OIDC-compliant identity provider
- No CloudTAK code changes needed for different IdPs
- ALB handles token validation and refresh
- Secure: CloudTAK never sees IdP credentials
- Scalable: ALB handles authentication load

## Backend Implementation

### 1. Authentication Library (`api/lib/auth.ts`)

Add OIDC parser and feature flag:

```typescript
import { Request } from 'express';
import Err from '@openaddresses/batch-error';

// OIDC authentication parser for ALB OIDC headers
export function oidcParser(req: Request): AuthUser {
    if (!process.env.ALB_OIDC_ENABLED || process.env.ALB_OIDC_ENABLED !== 'true') {
        throw new Err(404, null, 'OIDC authentication not enabled');
    }
    
    const oidcData = req.headers['x-amzn-oidc-data'];
    if (!oidcData || typeof oidcData !== 'string') {
        throw new Err(401, null, 'No OIDC data');
    }
    
    const payload = JSON.parse(
        Buffer.from(oidcData.split('.')[1], 'base64').toString()
    );
    
    if (!payload.email) {
        throw new Err(401, null, 'No email in OIDC data');
    }
    
    return new AuthUser(AuthUserAccess.USER, payload.email);
}

export function isOidcEnabled(): boolean {
    return process.env.ALB_OIDC_ENABLED === 'true';
}
```

### 2. Login Routes (`api/routes/login.ts`)

Add OIDC login endpoint:

```typescript
await schema.get('/login/oidc', {
    name: 'OIDC Login',
    group: 'Login',
    description: 'Login via ALB OIDC authentication',
    query: Type.Object({
        redirect: Type.Optional(Type.String({ default: '/' }))
    })
}, async (req, res) => {
    try {
        if (!isOidcEnabled()) {
            return res.status(404).json({ 
                status: 404, 
                message: 'OIDC authentication not enabled' 
            });
        }
        
        const auth = oidcParser(req);
        
        // Check if user exists, auto-create if not
        let profile;
        try {
            profile = await config.models.Profile.from(auth.email);
        } catch (err) {
            if (err instanceof Error && err.message.includes('Item Not Found')) {
                // Auto-create user with default settings
                profile = await config.models.Profile.generate({
                    username: auth.email,
                    auth: { ca: [], key: '', cert: '' },
                    system_admin: false,
                    agency_admin: [],
                    last_login: new Date().toISOString()
                });
            } else {
                throw err;
            }
        }
        
        // Update last login
        await config.models.Profile.commit(profile.username, {
            last_login: new Date().toISOString()
        });
        
        // Determine access level from profile
        let access = AuthUserAccess.USER;
        if (profile.system_admin) {
            access = AuthUserAccess.ADMIN;
        } else if (profile.agency_admin && profile.agency_admin.length) {
            access = AuthUserAccess.AGENCY;
        }
        
        // Generate JWT token
        const token = jwt.sign(
            { access, email: profile.username },
            config.SigningSecret,
            { expiresIn: '16h' }
        );
        
        // Redirect back to frontend with token
        const redirect = req.query.redirect || '/';
        const frontendUrl = `/login?token=${token}&redirect=${encodeURIComponent(redirect)}`;
        
        return res.redirect(frontendUrl);
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Authentication failed';
        return res.redirect(`/login?error=${encodeURIComponent(errorMsg)}`);
    }
});
```

## Frontend Implementation

### 1. Login Page (`api/web/src/components/Login.vue`)

Add OIDC login button:

```vue
<template>
    <div class='login-container'>
        <!-- Existing username/password form -->
        
        <!-- OIDC Login Button -->
        <div v-if='oidcEnabled' class='mt-3'>
            <div class='text-center mb-2'>or</div>
            <a :href='oidcLoginUrl' class='btn btn-primary w-100'>
                <IconLogin :size='20' />
                Sign in with SSO
            </a>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { std } from '../std.ts';

const route = useRoute();
const router = useRouter();
const oidcEnabled = ref(false);

const oidcLoginUrl = computed(() => {
    const redirect = route.query.redirect || '/';
    return `/api/login/oidc?redirect=${encodeURIComponent(redirect)}`;
});

onMounted(async () => {
    // Check if OIDC is enabled
    try {
        const response = await fetch('/api/login/oidc');
        oidcEnabled.value = response.status !== 404;
    } catch (err) {
        oidcEnabled.value = false;
    }
    
    // Handle token from OIDC redirect
    if (route.query.token) {
        localStorage.token = route.query.token;
        const redirect = route.query.redirect || '/';
        router.push(redirect);
    }
    
    // Handle error from OIDC redirect
    if (route.query.error) {
        console.error('OIDC login error:', route.query.error);
        // Show error to user
    }
});
</script>
```

## Configuration

### Environment Variables

```bash
# Enable OIDC authentication
ALB_OIDC_ENABLED=true
```

### ALB Configuration (Infrastructure)

The ALB must be configured with OIDC authentication:

```typescript
// Example CDK configuration
const listener = alb.addListener('HttpsListener', {
    port: 443,
    certificates: [certificate],
    defaultAction: elbv2.ListenerAction.authenticateOidc({
        authorizationEndpoint: 'https://idp.example.com/oauth2/authorize',
        tokenEndpoint: 'https://idp.example.com/oauth2/token',
        userInfoEndpoint: 'https://idp.example.com/oauth2/userinfo',
        clientId: 'cloudtak-client-id',
        clientSecret: elbv2.SecretValue.secretsManager('oidc-client-secret'),
        issuer: 'https://idp.example.com',
        scope: 'openid email profile',
        onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
        next: elbv2.ListenerAction.forward([targetGroup])
    })
});

// Allow unauthenticated access to login page and API login endpoint
listener.addAction('AllowLogin', {
    priority: 1,
    conditions: [
        elbv2.ListenerCondition.pathPatterns(['/login', '/api/login/*'])
    ],
    action: elbv2.ListenerAction.forward([targetGroup])
});
```

## Security Considerations

1. **Token Validation**: ALB validates OIDC tokens before passing to CloudTAK
2. **JWT Expiration**: CloudTAK JWT tokens expire after 16 hours
3. **Auto-Provisioning**: New users are created with minimal permissions (USER access)
4. **Role Mapping**: System admin and agency admin roles must be set separately (see related feature request for external provider integration)

## Testing

1. Configure ALB with OIDC authentication pointing to your IdP
2. Set `ALB_OIDC_ENABLED=true` in CloudTAK environment
3. Navigate to CloudTAK login page
4. Click "Sign in with SSO" button
5. Complete authentication with IdP
6. Verify redirect back to CloudTAK with valid session
7. Verify new user profile is auto-created
8. Verify JWT token works for API requests

## Related Feature Requests

- **External Provider Integration for Authentik**: Automatic certificate enrollment and role synchronization (see separate feature request)
- **Generic External Provider Interface**: Extensible framework for IdP-specific integrations

## Benefits for Upstream

- Enables enterprise adoption of CloudTAK
- Works with any OIDC provider (vendor-neutral)
- Minimal code changes (single endpoint + helper functions)
- No breaking changes to existing authentication
- Follows AWS best practices for ALB OIDC

## Implementation Notes

- OIDC authentication is opt-in via environment variable
- Traditional username/password authentication remains available
- Auto-provisioning creates users with default settings
- Role assignment requires separate mechanism (manual or via external provider integration)

These functions are specific to Authentik but can be adapted for other providers:

```typescript
// Get IdP API token from Secrets Manager
async function getIdPToken(): Promise<string> {
    const client = new SecretsManagerClient();
    const command = new GetSecretValueCommand({
        SecretId: process.env.AUTHENTIK_API_TOKEN_SECRET_ARN
    });
    
    const response = await client.send(command);
    
    if (!response.SecretString) {
        throw new Error('IdP API token secret is empty');
    }
    
    try {
        const secret = JSON.parse(response.SecretString);
        return secret.token || response.SecretString;
    } catch {
        return response.SecretString;
    }
}

// Fetch user attributes from Authentik
async function getIdPUserAttributes(
    username: string,
    authToken: string,
    authentikUrl: string
): Promise<{ takCallsign?: string; takColor?: string }> {
    const apiUrl = authentikUrl.endsWith('/') ? authentikUrl.slice(0, -1) : authentikUrl;
    
    const userResponse = await axios.get(
        `${apiUrl}/api/v3/core/users/?username=${encodeURIComponent(username)}`,
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    if (!userResponse.data.results || userResponse.data.results.length === 0) {
        return {};
    }
    
    const user = userResponse.data.results[0];
    const attributes = user.attributes || {};
    
    return {
        takCallsign: attributes.takCallsign,
        takColor: attributes.takColor
    };
}

// Create application password in Authentik for certificate enrollment
async function createIdPAppPassword(
    username: string,
    authToken: string,
    authentikUrl: string
): Promise<string> {
    const apiUrl = authentikUrl.endsWith('/') ? authentikUrl.slice(0, -1) : authentikUrl;
    
    // Get user ID
    const userResponse = await axios.get(
        `${apiUrl}/api/v3/core/users/?username=${encodeURIComponent(username)}`,
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    if (!userResponse.data.results || userResponse.data.results.length === 0) {
        throw new Error(`User ${username} not found in IdP`);
    }
    
    const userId = userResponse.data.results[0].pk;
    
    // Create temporary token for certificate enrollment
    const tokenIdentifier = `CloudTAK-Auto-${username.replace(/[@.]/g, '-')}-${Date.now()}`;
    const expirationDate = new Date();
    expirationDate.setMinutes(expirationDate.getMinutes() + 30);
    
    await axios.post(
        `${apiUrl}/api/v3/core/tokens/`,
        {
            identifier: tokenIdentifier,
            intent: 'app_password',
            user: userId,
            description: 'CloudTAK automatic certificate enrollment',
            expires: expirationDate.toISOString(),
            expiring: true
        },
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    // Get token key
    const keyResponse = await axios.get(
        `${apiUrl}/api/v3/core/tokens/${tokenIdentifier}/view_key/`,
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    return keyResponse.data.key;
}
```

## Frontend Implementation

### Login Component (`api/web/src/components/Login.vue`)

Add SSO button:

```vue
<script setup lang="ts">
import { IconKey } from '@tabler/icons-vue';

const ssoEnabled = ref(false);

onMounted(async () => {
    try {
        const response = await fetch('/api/server/oidc');
        const config = await response.json() as { oidc_enabled: boolean };
        ssoEnabled.value = config.oidc_enabled;
    } catch (err) {
        console.error('Failed to check OIDC status:', err);
    }
});

function loginWithSSO() {
    window.location.href = '/api/login/oidc';
}
</script>

<template>
    <button 
        v-if="ssoEnabled"
        @click="loginWithSSO"
        class="btn btn-primary w-100 mb-2"
    >
        <IconKey :size="20" stroke="2" class="me-2"/>
        Login with SSO
    </button>
</template>
```

### App Component (`api/web/src/App.vue`)

Handle logout:

```vue
<script setup lang="ts">
function logout() {
    user.value = undefined;
    delete localStorage.token;

    // Redirect to backend logout endpoint
    window.location.href = '/api/logout';
}
</script>
```

### Logout Route (`api/routes/login.ts`)

Add logout endpoint following AWS ALB documentation:

```typescript
// Logout endpoint - clears ALB OIDC cookies and redirects to IdP logout
// https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html#authentication-logout
await schema.get('/logout', {
    name: 'Logout',
    group: 'Login',
    description: 'Logout and clear ALB OIDC session'
}, async (req, res) => {
    try {
        // Set expiration to -1 for all ALB authentication cookies
        const cookieName = process.env.ALB_AUTH_SESSION_COOKIE || 'AWSELBAuthSessionCookie';
        const cookieOptions = {
            path: '/',
            httpOnly: true,
            secure: true,
            maxAge: -1  // Expire the cookie
        };
        
        // ALB can create up to 4 cookie shards (0-3)
        for (let i = 0; i < 4; i++) {
            res.cookie(`${cookieName}-${i}`, '', cookieOptions);
        }
        
        // Redirect to IdP logout endpoint if configured
        if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_APP_SLUG) {
            const authentikUrl = process.env.AUTHENTIK_URL.replace(/\/$/, '');
            const appSlug = process.env.AUTHENTIK_APP_SLUG;
            const logoutUrl = `${authentikUrl}/application/o/${appSlug}/end-session/`;
            return res.redirect(logoutUrl);
        } else {
            return res.redirect('/login');
        }
    } catch (err) {
        console.error('Logout error:', err);
        Err.respond(err, res);
    }
});
```

## Server Routes (`api/routes/server.ts`)

Add public OIDC status endpoint:

```typescript
await schema.get('/server/oidc', {
    name: 'Get OIDC Config',
    group: 'Server',
    description: 'Get OIDC configuration (public endpoint)',
    res: Type.Object({
        oidc_enabled: Type.Boolean(),
        authentik_url: Type.Optional(Type.String())
    })
}, async (req, res) => {
    return res.json({
        oidc_enabled: isOidcEnabled(),
        authentik_url: process.env.AUTHENTIK_URL
    });
});
```

## Provider Adaptation Guide

### For Other Identity Providers

The automatic certificate enrollment is **optional** and provider-specific. To adapt for other providers:

#### Okta
- Use Okta API to fetch user profile attributes
- Generate temporary password via Okta API or use service account
- Adapt `getIdPUserAttributes()` and `createIdPAppPassword()` functions

#### Azure AD
- Use Microsoft Graph API to fetch user attributes
- Use Azure AD application credentials for certificate enrollment
- Adapt helper functions to use Graph API endpoints

#### Generic OIDC (No Auto-Enrollment)
- Remove the optional IdP integration section entirely
- Users will need to manually enroll certificates after first login
- Profile attributes will use defaults (can be updated in settings)

## TAK.NZ Implementation Notes

The TAK.NZ deployment uses Authentik as the identity provider with the following configuration:

### User Attributes
- **takCallsign**: User's callsign for TAK display
- **takColor**: User's team color (maps to TAK groups like Blue, Red, Orange, etc.)

### Access Control via Groups
- **CloudTAKSystemAdmin** (configurable): System administrator with full access
  - Default group name: `CloudTAKSystemAdmin`
  - Configurable via `OIDC_SYSTEM_ADMIN_GROUP` environment variable
  - Mapped from OIDC `groups` claim on every login
  - Grants `system_admin = true` in user profile
  - Full access to all CloudTAK features and settings
  - Group membership changes take effect on next login

- **CloudTAKAgencyAdminX** (configurable): Agency administrator for agency X
  - Default group prefix: `CloudTAKAgencyAdmin`
  - Configurable via `OIDC_AGENCY_ADMIN_GROUP_PREFIX` environment variable
  - Numeric suffix indicates agency ID (e.g., `CloudTAKAgencyAdmin1` for agency 1)
  - Mapped from OIDC `groups` claim on every login
  - Grants `agency_admin: [1]` in user profile
  - Can manage connections where `connection.agency` matches their agency IDs
  - Supports multiple agencies: user in `CloudTAKAgencyAdmin1` and `CloudTAKAgencyAdmin5` gets `agency_admin: [1, 5]`
  - Group membership changes take effect on next login
  - Works without external system integration

### Automatic Provisioning
- **Certificate Enrollment with Auto-Retry**: Temporary 30-minute application passwords for TAK Server certificate requests
  - Automatically retries enrollment on every login if certificate is missing, invalid, or expired
  - Renews certificates expiring within 7 days
  - Self-healing: users never stuck without valid certificates
- **Role Assignment**: Groups mapped to roles on every login
  - System admin status synced from `OIDC_SYSTEM_ADMIN_GROUP` membership
  - Agency admin IDs synced from `OIDC_AGENCY_ADMIN_GROUP_PREFIX` + numeric suffix
  - Removing user from group revokes access on next login
  - Adding user to group grants access on next login
- **Attribute Sync**: Callsign and color fetched from user attributes on every login (configurable)
  - Prevents "Welcome to CloudTAK" modal for users with pre-configured attributes
  - Controlled by `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN` environment variable
  - Profile refreshed after attribute updates to ensure UI displays correct values
- **Manual Override**: System admins can modify roles in CloudTAK UI after initial provisioning

### Environment Variables
- `AUTHENTIK_URL`: Authentik instance URL
- `AUTHENTIK_API_TOKEN_SECRET_ARN`: Secrets Manager ARN for Authentik admin API token

This approach provides seamless onboarding while maintaining flexibility for other deployments.

## Configuration

### Environment Variables

- `ALB_OIDC_ENABLED`: Enable/disable OIDC authentication (true/false)
- `AUTHENTIK_URL`: Identity provider URL (for logout redirect and API calls)
- `AUTHENTIK_APP_SLUG`: Application slug in Authentik (for logout redirect)
- `AUTHENTIK_API_TOKEN_SECRET_ARN`: Secrets Manager ARN for IdP API token (optional, for auto-enrollment)
- `ALB_AUTH_SESSION_COOKIE`: Cookie name for ALB authentication session (default: "AWSELBAuthSessionCookie")
- `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN`: Sync user attributes from Authentik on every login (default: true)
- `OIDC_SYSTEM_ADMIN_GROUP`: Group name for system administrators (default: "CloudTAKSystemAdmin")
- `OIDC_AGENCY_ADMIN_GROUP_PREFIX`: Group prefix for agency administrators (default: "CloudTAKAgencyAdmin")

### Feature Flag

The `ALB_OIDC_ENABLED` environment variable acts as a feature flag:
- When `false` or unset: Traditional username/password login only
- When `true`: SSO button appears, OIDC endpoints active

## Benefits

1. **Enterprise Ready**: Integrates with existing identity infrastructure
2. **Flexible**: Works with any OIDC provider, optional IdP integration
3. **Backward Compatible**: Feature flag ensures zero impact when disabled
4. **Secure**: Leverages IdP security features and temporary credentials
5. **User Friendly**: Single sign-on with automatic certificate provisioning
6. **Self-Healing**: Automatic certificate retry and renewal on every login
7. **Zero Maintenance**: Expired certificates automatically renewed (7-day threshold)
8. **Seamless Onboarding**: Attribute syncing prevents setup dialogs for pre-configured users
9. **Mobile Optimized**: Nginx buffer configuration handles large ALB OIDC cookies

## Testing

1. Deploy with `ALB_OIDC_ENABLED=false` - verify traditional login works
2. Deploy with `ALB_OIDC_ENABLED=true` - verify SSO button appears
3. Test first-time login - verify user creation, attribute sync, and certificate enrollment
4. Test existing user login - verify authentication, attribute sync, group sync, and token generation
5. Test group membership changes:
   - Add user to `CloudTAKSystemAdmin` group - verify system admin access on next login
   - Remove user from system admin group - verify access revoked on next login
   - Add user to `CloudTAKAgencyAdmin1` group - verify agency admin access on next login
   - Remove user from agency admin group - verify access revoked on next login
6. Test logout - verify ALB cookie expiration and IdP logout redirect
7. Check CloudWatch logs for OIDC payload structure, attribute sync, and group sync messages
8. Test on mobile devices - verify no "400 Request Header Too Large" errors
9. Verify callsign and color display correctly in UI after first login
