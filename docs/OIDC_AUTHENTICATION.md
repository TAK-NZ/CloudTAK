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

### Connection Certificate Auto-Renewal

ETL connections using the Authentik provider also support **automatic certificate renewal**:

- **Health Check Endpoint**: `GET /api/layer/:layerid/health`
- **ETL Library Integration**: @tak-ps/etl library calls this endpoint automatically at startup
- **Renewal Threshold**: Certificates expiring within 7 days
- **Self-Healing**: Automatic retry on next ETL execution if renewal fails
- **Zero Downtime**: Connection remains active during renewal
- **No ETL Changes**: Works transparently without modifying ETL task code

**How it works**:
1. ETL library calls health check endpoint at startup (using ETL_TOKEN)
2. Endpoint checks certificate expiration for the layer's connection
3. If expiring soon (≤7 days), triggers automatic renewal:
   - Creates temporary password in Authentik
   - Requests new certificate from TAK Server
   - Updates connection record with new certificate
   - Refreshes active connection if enabled
4. Returns health status to ETL
5. ETL continues with valid certificate

**Benefits**:
- No ETL task code changes required
- Automatic integration via @tak-ps/etl library
- Prevents ETL failures due to expired certificates
- Consistent with user certificate renewal behavior
- Minimal performance impact (check is fast, renewal only when needed)

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

## Forced OIDC Login

### Overview

CloudTAK supports forced OIDC authentication, requiring all non-system-admin users to authenticate via SSO. System administrators retain emergency access via local login.

### Configuration

**File:** `cdk/cdk.json`

```json
{
  "cloudtak": {
    "oidcEnabled": true,
    "oidcForced": true  // Set to false to allow local login for all users
  }
}
```

### User Access Matrix

| User Type | `/login` | `/login?local=true` | API `/api/login` |
|-----------|----------|---------------------|------------------|
| **Regular User** (oidcForced=true) | → OIDC redirect | → OIDC redirect | 403 Forbidden |
| **System Admin** (oidcForced=true) | → OIDC redirect | ✓ Local login | ✓ Local login |
| **Any User** (oidcForced=false) | ✓ Both options | ✓ Local login | ✓ Local login |

### Behavior

**When `oidcForced: true` (default):**
- Regular users visiting `/login` → Automatically redirected to OIDC
- Regular users visiting `/login?local=true` → Can see form but authentication fails, redirected to OIDC
- System admins visiting `/login` → Redirected to OIDC
- System admins visiting `/login?local=true` → Can use local login successfully

**When `oidcForced: false`:**
- All users can choose between local and OIDC login
- Traditional behavior maintained

### Implementation

**Backend (`api/routes/login.ts`):**
```typescript
const oidcForced = process.env.OIDC_FORCED === 'true';

if (oidcForced) {
    const tempProfile = await config.models.Profile.from(email);
    if (!tempProfile.system_admin) {
        throw new Err(403, null, 'Local login is restricted. Please use SSO.');
    }
}
```

**Frontend (`api/web/src/components/Login.vue`):**
```typescript
const oidcForced = ref(false);

onMounted(async () => {
    const config = await std('/api/server/oidc');
    oidcForced.value = config.oidc_forced || false;
    
    if (oidcForced.value && !route.query.local) {
        loginWithSSO();
        return;
    }
});
```

### Testing Scenarios

1. **Regular User - Auto Redirect**: Visit `/login` → Should redirect to Authentik
2. **Regular User - Local Attempt**: Visit `/login?local=true` → Should fail and redirect to OIDC
3. **System Admin - OIDC**: Visit `/login` → Should redirect to Authentik
4. **System Admin - Local**: Visit `/login?local=true` → Should allow local login
5. **API Login - Regular User**: POST to `/api/login` → Should return 403
6. **API Login - System Admin**: POST to `/api/login` → Should succeed

### Troubleshooting

**Regular users can still access local login:**
- Check `oidcForced` is `true` in `cdk.json`
- Verify `OIDC_FORCED` environment variable in ECS task
- Check `/api/server/oidc` endpoint response

**System admins cannot login locally:**
- Verify using `/login?local=true` URL
- Check user's `system_admin` status in database
- Review CloudTAK API logs

**Automatic redirect not working:**
- Open browser developer console
- Check for JavaScript errors
- Verify `/api/server/oidc` returns `oidc_forced: true`

### Quick Commands

```bash
# Check config
grep -A 5 "oidcForced" cdk/cdk.json

# Test OIDC config endpoint
curl https://map.tak.nz/api/server/oidc

# Test local login (should fail for non-admins)
curl -X POST https://map.tak.nz/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"user@example.com","password":"password"}'
```

### Rollback

To disable forced OIDC:

1. Edit `cdk/cdk.json`: `"oidcForced": false`
2. Deploy: `npm run deploy:dev`
3. Verify: `curl https://map.tak.nz/api/server/oidc`

## Connection Deletion and Cleanup

### Automatic Cleanup on Connection Deletion

When a connection is deleted in CloudTAK, the system performs comprehensive cleanup:

#### 1. Certificate Revocation

- **TAK Server Certificate**: Automatically revoked using `@tak-ps/node-tak` library
- **Immediate Effect**: Certificate becomes invalid immediately
- **Security**: Prevents deleted connections from accessing TAK Server
- **Implementation**: Uses `api.Certificate.revoke(hash)` method

#### 2. Authentik Service Account Deletion

- **Service Account**: Automatically deleted from Authentik
- **Safety Check**: Only deletes accounts marked as `machineUser: true`
- **Graceful Failure**: Connection deletion continues even if service account deletion fails
- **Logging**: Success and failure messages logged for audit trail

### Implementation Details

**Location**: `api/routes/connection.ts` (DELETE endpoint)

The deletion process follows this sequence:

1. **Validation**: Check for active layers, data syncs, and video leases
2. **Certificate Revocation**:
   ```typescript
   const { hash } = new X509Certificate(connection.auth.cert);
   const api = await TAKAPI.init(...);
   await api.Certificate.revoke(hash);
   ```
3. **Service Account Deletion** (Authentik only):
   ```typescript
   if (config.external instanceof AuthentikProvider) {
       await config.external.deleteMachineUser(machineUsername);
   }
   ```
4. **Database Cleanup**: Remove connection records, tokens, and features
5. **S3 Cleanup**: Delete connection assets

### Security Benefits

- **Defense in Depth**: Multiple layers of access control removed
- **Immediate Revocation**: Certificate invalid immediately, not waiting for expiration
- **Audit Trail**: All cleanup actions logged
- **No Orphaned Accounts**: Service accounts cleaned up automatically

### Error Handling

- **Certificate Revocation Failure**: Logged but doesn't block deletion
- **Service Account Deletion Failure**: Logged but doesn't block deletion
- **Graceful Degradation**: Connection deletion always succeeds
- **Retry**: Manual cleanup possible via Authentik admin interface if needed

### Comparison with COTAK OAuth

The Authentik implementation provides better cleanup than the original COTAK OAuth:

| Feature | COTAK OAuth | Authentik Provider |
|---------|-------------|--------------------|
| Certificate Revocation | ❌ Not implemented | ✅ Automatic |
| Machine User Deletion | ❌ Optional parameter not used | ✅ Automatic |
| Error Handling | ⚠️ Silent failure | ✅ Logged with graceful degradation |
| Safety Checks | ❌ None | ✅ Verifies machineUser attribute |

### Monitoring

Check CloudTAK logs for cleanup operations:

```bash
# Certificate revocation
Revoked certificate <hash> for connection <id>

# Service account deletion
Successfully deleted Authentik service account: <username>

# Errors
Failed to revoke certificate for connection <id>: <error>
Failed to delete machine user <username>: <error>
```
