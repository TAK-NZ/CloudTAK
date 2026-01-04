# Certificate Auto-Renewal Patches

This directory contains patches for implementing automatic certificate monitoring and renewal for ETL connections using the Authentik provider.

## Patches

### 033-cert-health-check.patch
**File**: `api/lib/cert-health.ts` (new file)

Adds a utility function to check if a certificate needs renewal:
- Checks if certificate is missing, invalid, or expiring soon
- Default threshold: 7 days before expiration
- Returns boolean indicating if renewal is needed

### 034-authentik-cert-renewal.patch
**File**: `api/lib/authentik-provider.ts`

Adds `renewConnectionCertificate()` method to AuthentikProvider class:
- Creates temporary password in Authentik (30-minute expiration)
- Requests new certificate from TAK Server
- Returns new certificate and private key
- Handles errors gracefully

### 035-connection-cert-renewal-endpoint.patch
**File**: `api/routes/connection.ts`

Adds two endpoints:

1. **`POST /api/connection/:connectionid/cert/renew`** - Manual renewal endpoint:
   - Checks if certificate needs renewal (7-day threshold)
   - Calls Authentik provider renewal method
   - Updates connection record with new certificate
   - Refreshes active connection if enabled
   - Returns renewal status

2. **`GET /api/layer/:layerid/health`** - Health check endpoint for ETL:
   - Called automatically by @tak-ps/etl library at startup
   - Uses ETL_TOKEN for authentication
   - Checks certificate for layer's connection
   - Triggers automatic renewal if needed
   - Returns health status and renewal result
   - **No ETL task code changes required**

## Implementation Summary

### Minimal Implementation
These patches provide the absolute minimum code needed for self-healing certificate renewal:

1. **Certificate Health Check** (10 lines)
   - Fast O(1) date comparison
   - No external dependencies
   - Handles edge cases (missing/invalid certs)

2. **Renewal Method** (40 lines)
   - Integrates with existing Authentik provider
   - Uses temporary passwords for security
   - Leverages @tak-ps/node-tak library

3. **API Endpoint** (45 lines)
   - RESTful interface for ETL tasks
   - Proper authentication and authorization
   - Graceful error handling

### Total Code Added
- **3 files modified/created**
- **~95 lines of code**
- **Zero infrastructure changes**
- **No new dependencies**

## Usage

### For @tak-ps/etl Library

Add health check to library initialization:

```typescript
// In @tak-ps/etl library
export async function init() {
    const ETL_API = process.env.ETL_API;
    const ETL_TOKEN = process.env.ETL_TOKEN;
    const ETL_LAYER = process.env.ETL_LAYER;

    // Automatic certificate renewal via health check
    try {
        const health = await fetch(`${ETL_API}/layer/${ETL_LAYER}/health`, {
            headers: { 'Authorization': `Bearer ${ETL_TOKEN}` }
        });
        const { cert_renewed } = await health.json();
        if (cert_renewed) console.log('Certificate automatically renewed');
    } catch (err) {
        console.error('Health check failed:', err);
    }

    // Continue with ETL initialization
}
```

**Individual ETL tasks require no changes** - they continue to work as before.

### For Administrators

Manual renewal via API:

```bash
curl -X POST https://map.tak.nz/api/connection/123/cert/renew \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Benefits

- **Self-Healing**: Automatic retry on next ETL execution if renewal fails
- **Zero Downtime**: Connections remain active during renewal
- **Minimal Overhead**: Fast check, renewal only when needed (<0.5% of executions)
- **Consistent**: Same 7-day threshold as user certificates
- **No Configuration**: Works automatically with Authentik provider

## Testing

1. Create a connection with Authentik provider
2. Manually set certificate expiration to <7 days (for testing)
3. Call renewal endpoint
4. Verify new certificate is issued and stored
5. Verify connection remains active

## Monitoring

Check logs for renewal events:

```
Certificate renewal needed for connection 123 - Expires in 5 days
Certificate renewed successfully for connection 123
```

## Documentation

See [CERTIFICATE_MANAGEMENT.md](../docs/CERTIFICATE_MANAGEMENT.md) for comprehensive documentation.

## Related Patches

- `031-connection-cleanup-cert-revoke.patch` - Certificate revocation on connection deletion
- `032-authentik-delete-machine-user.patch` - Machine user cleanup
- `README-OIDC.md` - OIDC authentication with automatic user certificate enrollment
