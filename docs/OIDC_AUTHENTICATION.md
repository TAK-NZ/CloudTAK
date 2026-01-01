# OIDC Authentication Setup

This document describes the OIDC (OpenID Connect) authentication implementation for CloudTAK using AWS Application Load Balancer (ALB) and Authentik as the identity provider, with **automatic X.509 certificate enrollment** for new users.

## Overview

CloudTAK supports Single Sign-On (SSO) authentication through ALB OIDC integration. When enabled, users authenticate using their Authentik credentials and **automatically receive TAK Server certificates** required for full CloudTAK functionality (web UI + TAK clients).

## Architecture

```
User Browser
    ↓
    ↓ 1. Click "Login with SSO"
    ↓
ALB (OIDC Authentication)
    ↓
    ↓ 2. Redirect to Authentik
    ↓
Authentik Identity Provider
    ↓
    ↓ 3. User authenticates
    ↓
ALB (Validates OIDC token)
    ↓
    ↓ 4. Adds x-amzn-oidc-data header
    ↓
CloudTAK Backend (/api/login/oidc)
    ↓
    ↓ 5. Creates/updates user profile
    ↓
    ↓ 6. AUTOMATIC CERTIFICATE ENROLLMENT:
    ↓    - Get Authentik API token
    ↓    - Create application password (30min expiry)
    ↓    - Request cert from TAK Server
    ↓    - Store cert in profile
    ↓
    ↓ 7. Generate JWT token
    ↓
Frontend (/login?token=XXX)
    ↓
    ↓ 8. Store token and redirect
    ↓
CloudTAK Application
    ↓
    ↓ User has full access (web UI + TAK clients)
```

## Configuration

### CDK Configuration

Enable OIDC in `cdk/cdk.json`:

```json
{
  "context": {
    "dev-test": {
      "cloudtak": {
        "oidcEnabled": true,
        "authentikUrl": "https://account.test.tak.nz"
      }
    },
    "prod": {
      "cloudtak": {
        "oidcEnabled": true,
        "authentikUrl": "https://account.tak.nz"
      }
    }
  }
}
```

### Environment Variables

The following environment variables are automatically set by the CDK:

- `ALB_OIDC_ENABLED`: Set to `"true"` when OIDC is enabled
- `AUTHENTIK_URL`: URL of the Authentik instance (imported from AuthInfra)
- `AUTHENTIK_APP_SLUG`: Application slug in Authentik (default: "cloudtak")
- `AUTHENTIK_API_TOKEN_SECRET_ARN`: ARN of Secrets Manager secret containing Authentik admin token (imported from AuthInfra)
- `ALB_AUTH_SESSION_COOKIE`: Cookie name for ALB authentication session (default: "AWSELBAuthSessionCookie")
- `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN`: Set to `"true"` to sync user attributes (takCallsign, takColor) from Authentik on every login

## Components

### 1. Automated Authentik Setup

**Location**: `cdk/lib/constructs/cloudtak-oidc-setup.ts` and `cdk/src/cloudtak-oidc-setup/`

A Lambda function automatically configures Authentik during deployment:

- Creates OAuth2 provider named "TAK-CloudTAK"
- Creates application named "CloudTAK" with slug "cloudtak"
- Assigns to "Team Awareness Kit" group
- Uploads CloudTAK logo as application icon
- Configures redirect URIs for ALB
- Stores client secret in AWS Secrets Manager

### 2. ALB OIDC Listener

**Location**: `cdk/lib/constructs/load-balancer.ts`

The ALB is configured with an OIDC authentication action at priority 10:

- Protects `/api/login/oidc` endpoint
- Validates OIDC tokens from Authentik
- Adds `x-amzn-oidc-data` header with user information
- Session timeout: 16 hours (matches JWT expiration)

### 3. Backend Authentication

**Location**: `api/lib/auth.ts`, `api/routes/login.ts`, `api/routes/server.ts`

Backend components handle OIDC authentication and automatic certificate enrollment:

- **oidcParser()**: Extracts email and groups from ALB OIDC headers, verifies JWT signature using ALB public keys
- **isOidcEnabled()**: Feature flag check
- **GET /api/login/oidc**: OIDC login endpoint
  - Auto-creates users on first login
  - **Automatic certificate enrollment**:
    - Gets Authentik API token from Secrets Manager
    - Creates application password in Authentik (30-minute expiration)
    - Requests certificate from TAK Server using that password
    - Stores certificate in user profile
  - **Authentik attribute syncing** (when enabled):
    - Fetches takCallsign and takColor from Authentik user attributes
    - Updates CloudTAK profile with these attributes
    - Prevents "Welcome to CloudTAK" modal for users with pre-configured attributes
  - Updates last_login timestamp
  - Generates JWT token
  - Redirects to frontend with token
- **GET /api/logout**: Logout endpoint
  - Expires all ALB authentication cookie shards (0-3)
  - Redirects to Authentik end-session endpoint
- **GET /api/server/oidc**: Public endpoint for OIDC status

### 4. Nginx Configuration

**Location**: `api/nginx.conf.js`

Nginx is configured to handle large ALB OIDC cookies:

```javascript
// Increase buffer sizes for ALB OIDC cookies
large_client_header_buffers 4 32k;
client_header_buffer_size 32k;
```

This prevents "400 Request Header Or Cookie Too Large" errors, especially on mobile devices where cookies can exceed default buffer sizes.

### 5. Frontend Integration

**Location**: `api/web/src/components/Login.vue`, `api/web/src/App.vue`, `api/web/src/components/CloudTAK/MainMenuContents.vue`

Frontend components provide SSO user experience:

- **Login.vue**: 
  - Displays "Login with SSO" button when enabled
  - Handles token from OIDC redirect
  - Redirects to `/api/login/oidc` on SSO button click
- **App.vue**:
  - Fetches OIDC configuration on mount
  - Logout clears localStorage and redirects to `/api/logout`
- **MainMenuContents.vue**:
  - Logout clears localStorage and redirects to `/api/logout`

## User Flows

### Login Flow

1. User navigates to `/login`
2. Frontend checks `/api/server/oidc` to see if SSO is available
3. "Login with SSO" button appears if enabled
4. User clicks SSO button → redirects to `/api/login/oidc`
5. ALB intercepts and redirects to Authentik
6. User authenticates with Authentik
7. ALB validates token and forwards to CloudTAK with OIDC headers
8. Backend creates/updates user profile
9. **Backend automatically enrolls certificate** (if new user):
   - Creates application password in Authentik
   - Requests certificate from TAK Server
   - Stores certificate in profile
10. Backend generates JWT token
11. Backend redirects to `/login?token=XXX&redirect=/`
12. Frontend stores token and redirects to destination
13. **User has full access** (web UI + TAK clients)

### Logout Flow

1. User clicks logout in CloudTAK
2. Frontend clears localStorage token
3. Frontend redirects to `/api/logout`
4. Backend expires all ALB authentication cookie shards (0-3) by setting maxAge: -1
5. Backend redirects to `https://account.test.tak.nz/application/o/cloudtak/end-session/`
6. Authentik terminates session
7. User is logged out of both CloudTAK and Authentik

### First-Time User

When a user logs in via SSO for the first time:

1. Backend checks if profile exists
2. If not found, auto-creates profile with:
   - Username: user's email from OIDC
   - Access level: USER (default, or ADMIN if in CloudTAKSystemAdmin group)
   - Empty certificate data (initially)
3. **Automatic certificate enrollment with retry**:
   - Gets Authentik API token from Secrets Manager
   - Creates application password in Authentik (30-minute expiration)
   - Uses that password to request certificate from TAK Server
   - Stores certificate in user profile
   - **If enrollment fails**: User can login again to retry (self-healing)
4. **Authentik attribute syncing** (when enabled):
   - Fetches takCallsign and takColor from Authentik user attributes
   - Updates CloudTAK profile with these attributes
   - Prevents "Welcome to CloudTAK" modal for users with pre-configured attributes
5. User can access CloudTAK immediately with full functionality
6. Admin can upgrade access level if needed

### Certificate Auto-Retry Behavior

CloudTAK implements **self-healing certificate enrollment**:

- **On every OIDC login**: System checks if user has a valid certificate
- **If certificate is missing, invalid, or expired**: Automatically retries enrollment
- **Expiration threshold**: Certificates expiring within 7 days are automatically renewed
- **No manual intervention needed**: User simply logs in again to retry
- **Graceful failure**: Login succeeds even if enrollment fails (retry on next login)

This ensures users are never permanently stuck without certificates due to transient failures (network issues, service unavailability, etc.) or certificate expiration.

## Security

### Authentication Flow

- ALB validates OIDC tokens before forwarding to CloudTAK
- CloudTAK validates `ALB_OIDC_ENABLED` flag
- JWT tokens maintain 16-hour expiration
- Existing authorization model (ADMIN/AGENCY/USER) unchanged

### Secrets Management

- Authentik admin token: Stored in Secrets Manager (from AuthInfra)
- OAuth client secret: Stored in Secrets Manager by OIDC setup Lambda
- Application passwords: Temporary (30-minute expiration), used only for certificate enrollment
- X.509 certificates: Stored encrypted in CloudTAK database
- KMS encryption: All secrets encrypted with customer-managed key

### Network Security

- OIDC setup Lambda runs in VPC with NAT gateway access
- Uses ECS security group for Authentik connectivity
- Private subnets with controlled internet access

## Deployment

### Prerequisites

1. BaseInfra stack deployed
2. AuthInfra stack deployed with Authentik
3. TakInfra stack deployed

### Deploy with OIDC

```bash
cd cdk
npm run deploy:dev   # or deploy:prod
```

The deployment will:

1. Create OIDC setup Lambda function
2. Execute Lambda to configure Authentik
3. Store client secret in Secrets Manager
4. Configure ALB with OIDC listener
5. Set environment variables in CloudTAK container
6. Deploy updated CloudTAK application

### Verify Deployment

1. Navigate to CloudTAK login page
2. Verify "Login with SSO" button appears
3. Click SSO button and authenticate with Authentik
4. Verify successful login to CloudTAK
5. Verify logout redirects to Authentik

## Troubleshooting

### SSO Button Not Appearing

- Check `/api/server/oidc` returns `{"oidc_enabled": true}`
- Verify `ALB_OIDC_ENABLED` environment variable is set to `"true"`
- Check CloudTAK container logs for errors

### OIDC Login Fails

- Verify ALB listener rule is configured at priority 10
- Check Authentik application configuration
- Verify redirect URIs match ALB OAuth callback
- Check CloudTAK logs for authentication errors

### User Not Created

- Verify OIDC payload contains email field
- Check CloudTAK database permissions
- Review CloudTAK logs for profile creation errors

### Certificate Enrollment Fails

- Check `AUTHENTIK_API_TOKEN_SECRET_ARN` environment variable is set
- Verify Authentik admin token has correct permissions
- Check TAK Server is accessible from CloudTAK
- Review CloudTAK logs for enrollment errors
- Note: Login still succeeds even if enrollment fails (user can retry on next login)

### User Attributes Not Syncing

- Verify `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN` is set to `"true"`
- Check Authentik user has `takCallsign` and `takColor` attributes set
- Review CloudTAK logs for attribute fetch errors:
  - Look for "Fetched Authentik attributes" log message
  - Look for "Profile updates" log message
  - Look for "Successfully updated profile attributes" log message
- Verify attribute names match exactly: `takCallsign` and `takColor` (case-sensitive)

### 400 Request Header Too Large Error

- This occurs when ALB OIDC cookies exceed Nginx buffer sizes
- Verify nginx.conf.js includes:
  ```javascript
  large_client_header_buffers 4 32k;
  client_header_buffer_size 32k;
  ```
- Redeploy if nginx configuration is missing these settings

### Logout Not Working

- Verify `AUTHENTIK_URL` environment variable is set
- Check Authentik end-session endpoint is accessible
- Verify application slug is "cloudtak"

## Configuration Options

### Disabling OIDC

To disable OIDC authentication:

1. Update `cdk/cdk.json`:
   ```json
   {
     "cloudtak": {
       "oidcEnabled": false
     }
   }
   ```

2. Redeploy:
   ```bash
   npm run deploy:dev
   ```

3. SSO button will disappear from login page
4. Username/password authentication continues to work

### Disabling Attribute Syncing

To disable automatic attribute syncing from Authentik:

1. Update `cdk/cdk.json`:
   ```json
   {
     "cloudtak": {
       "syncAuthentikAttributesOnLogin": false
     }
   }
   ```

2. Redeploy:
   ```bash
   npm run deploy:dev
   ```

3. User attributes will only be synced for new users, not on every login
4. Users can still manually set their callsign and color in CloudTAK settings

## Backward Compatibility

- OIDC is completely disabled when `oidcEnabled: false`
- Username/password authentication always available
- No database schema changes required
- Existing users unaffected
- Zero impact when feature is disabled
