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

## Motivation

Enterprise deployments require centralized authentication through identity providers (Authentik, Okta, Azure AD, etc.) rather than managing separate credentials in each application. CloudTAK's requirement for X.509 certificates makes SSO integration more complex than typical web applications.

### Why This Matters

1. **Enterprise SSO**: Organizations need CloudTAK to integrate with their existing identity infrastructure
2. **Simplified Management**: Centralized user provisioning, deprovisioning, and access control
3. **Enhanced Security**: Leverage IdP security features (MFA, conditional access, audit logging)
4. **Seamless Onboarding**: Users authenticate once and immediately have full CloudTAK access including certificates

## Implementation Overview

This feature has two components:

1. **OIDC Authentication** (Core) - Works with any OIDC-compliant provider via ALB
2. **Automatic Certificate Enrollment** (Optional) - Provider-specific integration for passwordless certificate provisioning

### Architecture

```
User → ALB OIDC → Identity Provider → ALB (validates) → CloudTAK Backend
                                                              ↓
                                                    Extract email from OIDC token
                                                              ↓
                                                    Auto-create user profile (if new)
                                                              ↓
                                          [Optional: Fetch user attributes from IdP API]
                                                              ↓
                                          [Optional: Auto-enroll certificate via IdP]
                                                              ↓
                                                    Generate JWT token
                                                              ↓
                                                    Redirect to frontend
```

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
    
    // Debug: Log OIDC payload to see available claims
    console.log('OIDC Payload:', JSON.stringify(payload, null, 2));
    
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
import { TAKAPI, APIAuthPassword } from '@tak-ps/node-tak';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import axios from 'axios';

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
                
                // Optional: Fetch user attributes and auto-enroll certificate
                // This section is provider-specific (example uses Authentik)
                if (process.env.AUTHENTIK_API_TOKEN_SECRET_ARN && 
                    config.server.auth.key && 
                    config.server.auth.cert) {
                    try {
                        console.log(`Starting automatic setup for ${auth.email}`);
                        
                        // Get identity provider API token
                        const idpToken = await getIdPToken();
                        
                        // Fetch user attributes from IdP (callsign, color, etc.)
                        const userAttrs = await getIdPUserAttributes(
                            auth.email,
                            idpToken,
                            process.env.AUTHENTIK_URL
                        );
                        
                        // Update profile with IdP attributes
                        const updates: any = {};
                        if (userAttrs.takCallsign) updates.tak_callsign = userAttrs.takCallsign;
                        if (userAttrs.takColor) updates.tak_group = userAttrs.takColor;
                        
                        if (Object.keys(updates).length > 0) {
                            await config.models.Profile.commit(auth.email, updates);
                        }
                        
                        // Create application password for certificate enrollment
                        const appPassword = await createIdPAppPassword(
                            auth.email,
                            idpToken,
                            process.env.AUTHENTIK_URL
                        );
                        
                        // Request certificate from TAK Server
                        const takAuth = new APIAuthPassword(auth.email, appPassword);
                        const api = await TAKAPI.init(new URL(config.server.webtak), takAuth);
                        const certs = await api.Credentials.generate();
                        
                        // Update profile with certificate
                        await config.models.Profile.commit(auth.email, {
                            auth: certs
                        });
                        
                        profile = await config.models.Profile.from(auth.email);
                        console.log(`Automatic setup completed for ${auth.email}`);
                    } catch (setupErr) {
                        console.error('Failed to complete automatic setup:', setupErr);
                        // Don't fail login - user can complete setup manually
                    }
                }
            } else {
                throw err;
            }
        }
        
        // Update last login
        await config.models.Profile.commit(profile.username, {
            last_login: new Date().toISOString()
        });
        
        // Determine access level
        // Group-based role mapping from OIDC token
        // Reads from database profile fields set during user creation:
        //   - profile.system_admin (boolean) → ADMIN access
        //   - profile.agency_admin (array of numeric agency IDs) → AGENCY access
        //
        // System admin is set from 'CloudTAKSystemAdmin' group membership
        // Agency admin requires external system integration (not implemented here)
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

### 3. Helper Functions (Provider-Specific)

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
- **CloudTAKSystemAdmin**: System administrator with full access
  - Mapped from OIDC `groups` claim during first login
  - Grants `system_admin = true` in user profile
  - Full access to all CloudTAK features and settings

**Note**: Agency admin roles (`agency_admin` field) require CloudTAK's external system integration to be configured. Without an external system, only system admin and regular user roles are available.

### Automatic Provisioning
- **Certificate Enrollment with Auto-Retry**: Temporary 30-minute application passwords for TAK Server certificate requests
  - Automatically retries enrollment on every login if certificate is missing, invalid, or expired
  - Renews certificates expiring within 7 days
  - Self-healing: users never stuck without valid certificates
- **Role Assignment**: Groups mapped to roles on first login only
- **Attribute Sync**: Callsign and color fetched from user attributes
- **Manual Override**: System admins can modify roles in CloudTAK UI after initial provisioning

### Environment Variables
- `AUTHENTIK_URL`: Authentik instance URL
- `AUTHENTIK_API_TOKEN_SECRET_ARN`: Secrets Manager ARN for Authentik admin API token

This approach provides seamless onboarding while maintaining flexibility for other deployments.

## Configuration

### Environment Variables

- `ALB_OIDC_ENABLED`: Enable/disable OIDC authentication (true/false)
- `AUTHENTIK_URL`: Identity provider URL (for logout redirect)
- `AUTHENTIK_APP_SLUG`: Application slug in Authentik (for logout redirect)
- `AUTHENTIK_API_TOKEN_SECRET_ARN`: Secrets Manager ARN for IdP API token (optional, for auto-enrollment)

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

## Testing

1. Deploy with `ALB_OIDC_ENABLED=false` - verify traditional login works
2. Deploy with `ALB_OIDC_ENABLED=true` - verify SSO button appears
3. Test first-time login - verify user creation and certificate enrollment
4. Test existing user login - verify authentication and token generation
5. Test logout - verify IdP logout redirect
6. Check CloudWatch logs for OIDC payload structure
