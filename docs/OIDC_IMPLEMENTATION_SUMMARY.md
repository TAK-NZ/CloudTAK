# OIDC Implementation Summary

This document summarizes the complete OIDC authentication implementation for CloudTAK with AWS ALB and Authentik.

## Features Implemented

### 1. Core OIDC Authentication
- ALB OIDC integration with Authentik identity provider
- JWT signature verification using ALB public keys with IEEE P1363 encoding
- Automatic user creation on first login
- Group-based role assignment (CloudTAKSystemAdmin → ADMIN access)
- 16-hour session timeout matching JWT expiration

### 2. Automatic Certificate Enrollment
- Self-healing certificate enrollment on every login
- Creates temporary application password in Authentik (30-minute expiration)
- Requests X.509 certificate from TAK Server
- Stores certificate in user profile
- Automatic retry on certificate expiration (7-day threshold)
- Graceful failure handling (login succeeds even if enrollment fails)

### 3. Authentik Attribute Syncing
- Configurable attribute syncing on every login
- Syncs `takCallsign` and `takColor` from Authentik user attributes
- Prevents "Welcome to CloudTAK" modal for pre-configured users
- Controlled by `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN` environment variable
- Detailed logging for troubleshooting

### 4. Proper Logout Implementation
- Expires all ALB authentication cookie shards (0-3)
- Redirects to Authentik end-session endpoint
- Clears both CloudTAK and Authentik sessions
- Follows AWS ALB logout documentation

### 5. Nginx Buffer Configuration
- Increased buffer sizes to handle large ALB OIDC cookies
- Prevents "400 Request Header Or Cookie Too Large" errors
- Especially important for mobile devices

## Patches Applied

All patches are located in `scripts/patches/` and applied automatically during build:

| Patch | File | Description |
|-------|------|-------------|
| 011 | `api/lib/auth.ts` | JWT signature verification with IEEE P1363 encoding |
| 012 | `api/lib/types.ts` | Added OIDCUser type definition |
| 013 | `api/routes/login.ts` | OIDC login endpoint with certificate enrollment |
| 014 | `api/routes/server.ts` | Public OIDC status endpoint |
| 015 | `api/web/src/components/Login.vue` | SSO button and OIDC redirect |
| 016 | `api/web/src/App.vue` | OIDC config fetch and logout redirect |
| 017 | `api/web/src/components/CloudTAK/MainMenuContents.vue` | Logout redirect to /api/logout |
| 018 | `api/web/src/components/CloudTAK/Menu/MenuSettingsCallsign.vue` | Branding update |
| 019 | `api/web/src/components/CloudTAK/util/ShareToMission.vue` | Branding update |
| 020 | `api/nginx.conf.js` | Increased buffer sizes for ALB cookies |
| 021 | `api/routes/login.ts` | Authentik attribute syncing with logging |

## CDK Configuration

### Stack Configuration (`cdk/lib/stack-config.ts`)

```typescript
export interface CloudTAKConfig {
  oidcEnabled?: boolean;
  authentikAppSlug?: string;
  albAuthSessionCookie?: string;
  syncAuthentikAttributesOnLogin?: boolean;
}
```

### Context Configuration (`cdk/cdk.json`)

```json
{
  "cloudtak": {
    "oidcEnabled": true,
    "authentikAppSlug": "cloudtak",
    "albAuthSessionCookie": "AWSELBAuthSessionCookieCloudTAK",
    "syncAuthentikAttributesOnLogin": true
  }
}
```

### CDK Constructs

1. **`cloudtak-oidc-setup.ts`** - Lambda function for automated Authentik configuration
2. **`load-balancer.ts`** - ALB OIDC listener configuration at priority 10
3. **`cloudtak-api.ts`** - Environment variables and imports from AuthInfra

### CloudFormation Imports

Imports from AuthInfra stack:
- `AUTHENTIK_URL` - Authentik instance URL
- `AUTHENTIK_ADMIN_TOKEN_ARN` - Secrets Manager ARN for admin token

## Environment Variables

Set automatically by CDK in CloudTAK container:

| Variable | Source | Description |
|----------|--------|-------------|
| `ALB_OIDC_ENABLED` | CDK config | Feature flag for OIDC |
| `AUTHENTIK_URL` | AuthInfra export | Authentik instance URL |
| `AUTHENTIK_APP_SLUG` | CDK config | Application slug in Authentik |
| `AUTHENTIK_API_TOKEN_SECRET_ARN` | AuthInfra export | Secrets Manager ARN |
| `ALB_AUTH_SESSION_COOKIE` | CDK config | Cookie name for ALB session |
| `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN` | CDK config | Enable attribute syncing |

## API Endpoints

### Public Endpoints

- `GET /api/server/oidc` - Returns OIDC configuration status
  ```json
  {"oidc_enabled": true}
  ```

### Protected Endpoints (ALB OIDC)

- `GET /api/login/oidc` - OIDC login callback
  - Auto-creates users
  - Enrolls certificates
  - Syncs attributes
  - Generates JWT
  - Redirects to frontend

- `GET /api/logout` - Logout endpoint
  - Expires ALB cookies
  - Redirects to Authentik

## Security Considerations

### JWT Signature Verification

- Fetches ALB public keys from `https://public-keys.auth.elb.{region}.amazonaws.com/{key-id}`
- Verifies ES256 (ECDSA P-256) signatures with IEEE P1363 encoding
- Validates token expiration and issuer
- Uses `startsWith()` for issuer validation (Authentik includes app path)

### Secrets Management

- Authentik admin token: Secrets Manager (from AuthInfra)
- OAuth client secret: Secrets Manager (created by OIDC setup Lambda)
- Application passwords: Temporary (30-minute expiration)
- X.509 certificates: Encrypted in CloudTAK database
- KMS encryption: All secrets encrypted with customer-managed key

### Network Security

- OIDC setup Lambda runs in VPC with NAT gateway
- Uses ECS security group for Authentik connectivity
- Private subnets with controlled internet access

## Troubleshooting

### Enable Debug Logging

The implementation includes detailed logging for troubleshooting:

```
Retrying automatic certificate enrollment for user@example.com
Fetched Authentik attributes for user@example.com: {"takCallsign":"Alpha-1","takColor":"Blue"}
Profile updates for user@example.com: {"tak_callsign":"Alpha-1","tak_group":"Blue"}
Successfully updated profile attributes for user@example.com
Certificate enrolled successfully for user@example.com
```

### Common Issues

1. **SSO button not appearing**
   - Check `/api/server/oidc` returns `{"oidc_enabled": true}`
   - Verify `ALB_OIDC_ENABLED` environment variable

2. **400 Request Header Too Large**
   - Verify nginx buffer configuration is applied
   - Check `large_client_header_buffers 4 32k` in nginx.conf

3. **Attributes not syncing**
   - Verify `SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN=true`
   - Check Authentik user has `takCallsign` and `takColor` attributes
   - Review CloudTAK logs for attribute fetch messages

4. **Certificate enrollment fails**
   - Check `AUTHENTIK_API_TOKEN_SECRET_ARN` is set
   - Verify TAK Server is accessible
   - User can retry by logging in again (self-healing)

## Testing Checklist

- [ ] SSO button appears on login page
- [ ] Login redirects to Authentik
- [ ] User authenticates successfully
- [ ] User profile created automatically
- [ ] Certificate enrolled automatically
- [ ] Attributes synced from Authentik
- [ ] JWT token generated and stored
- [ ] User redirected to CloudTAK
- [ ] Logout clears session
- [ ] Logout redirects to Authentik
- [ ] Certificate auto-renews on expiration
- [ ] Mobile devices work without 400 errors

## Deployment

### Prerequisites

1. BaseInfra stack deployed
2. AuthInfra stack deployed with Authentik
3. TakInfra stack deployed

### Deploy Command

```bash
cd cdk
npm run deploy:dev   # or deploy:prod
```

### Verification

1. Check CloudFormation stack outputs
2. Verify ALB listener rules
3. Test SSO login flow
4. Check CloudWatch logs for errors
5. Verify certificate enrollment
6. Test attribute syncing
7. Test logout flow

## Documentation

- **[OIDC Authentication Guide](docs/OIDC_AUTHENTICATION.md)** - Complete implementation guide
- **[Deployment Guide](docs/DEPLOYMENT_GUIDE.md)** - Deployment instructions
- **[Architecture Guide](docs/ARCHITECTURE.md)** - Technical architecture
- **[Configuration Guide](docs/PARAMETERS.md)** - Configuration reference

## Future Enhancements

Potential improvements for future consideration:

1. **Multi-factor authentication** - Add MFA requirement for sensitive operations
2. **Certificate rotation** - Automated certificate rotation before expiration
3. **Attribute mapping** - Configurable attribute mapping from Authentik
4. **Group synchronization** - Sync Authentik groups to CloudTAK roles
5. **Session management** - Admin interface for viewing/revoking sessions
6. **Audit logging** - Enhanced audit trail for authentication events

## Backward Compatibility

- OIDC is completely optional (disabled by default)
- Username/password authentication always available
- No database schema changes required
- Existing users unaffected
- Zero impact when feature is disabled
- Graceful degradation if Authentik unavailable

## Version History

- **v1.0** - Initial OIDC implementation with ALB integration
- **v1.1** - Added automatic certificate enrollment
- **v1.2** - Added proper logout implementation
- **v1.3** - Added nginx buffer configuration for mobile support
- **v1.4** - Added Authentik attribute syncing with configurable toggle
- **v1.5** - Added detailed logging for troubleshooting

## Credits

Implementation based on:
- AWS ALB OIDC documentation
- Authentik OAuth2 provider documentation
- CloudTAK upstream architecture
- TAK Server certificate enrollment API
