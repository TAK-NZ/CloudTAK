# JWT Signature Verification Fix for ALB OIDC

## Issue

Users experiencing "Invalid JWT Signature" error when attempting to login via SSO, being redirected to `/login?error=Invalid%20JWT%20signature`.

## Root Cause

AWS Application Load Balancer (ALB) uses **ES256 (ECDSA with P-256 curve and SHA-256)** for signing OIDC JWT tokens. The signature is encoded in **IEEE P1363 format** (raw r||s concatenation), not DER format.

Node.js `crypto.verify()` by default expects DER-encoded signatures for ECDSA, which causes verification to fail when using the raw signature from ALB.

## Solution

### 1. Updated JWT Signature Verification

Modified `api/lib/auth.ts` to handle both IEEE P1363 and DER signature formats:

```typescript
function verifyJwtSignature(token: string, publicKeyPem: string): boolean {
    // ... token parsing ...
    
    // Try verification with ieee-p1363 encoding (ALB uses this for ES256)
    const isValid = verify.verify(
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature
    );
    
    // Fallback to DER encoding if needed
    // ...
}
```

### 2. Enhanced Error Logging

Added comprehensive logging throughout the OIDC authentication flow:

- Public key fetching status
- Signature verification attempts
- Detailed error messages for debugging

### 3. Optional Signature Verification Bypass (DEBUG ONLY)

Added environment variable `ALB_OIDC_SKIP_SIGNATURE_VERIFICATION` for debugging purposes:

```typescript
if (process.env.ALB_OIDC_SKIP_SIGNATURE_VERIFICATION === 'true') {
    console.warn('WARNING: JWT signature verification is DISABLED');
    // Skip verification
}
```

**⚠️ WARNING**: This should NEVER be used in production. It's only for debugging to isolate whether the issue is with signature verification or other parts of the authentication flow.

## Testing Steps

### 1. Deploy Updated Code

```bash
cd cdk
npm run deploy:dev  # or deploy:prod
```

### 2. Monitor Logs

Watch CloudWatch logs for the ECS service:

```bash
aws logs tail /aws/ecs/TAK-Dev-CloudTAK --follow
```

Look for these log messages:
- `Fetching ALB public key for region=...`
- `Successfully fetched ALB public key`
- `JWT signature verified successfully`

### 3. Test SSO Login

1. Navigate to your CloudTAK URL
2. Click "Login with SSO"
3. Complete authentication with Authentik
4. Should redirect back to CloudTAK successfully

### 4. If Still Failing

If signature verification still fails, temporarily enable debug mode to isolate the issue:

**In CDK** (`cdk/lib/constructs/cloudtak-api.ts`):

```typescript
environment: {
    // ... existing env vars ...
    'ALB_OIDC_SKIP_SIGNATURE_VERIFICATION': 'true'  // TEMPORARY DEBUG ONLY
}
```

Redeploy and test. If login works with verification disabled, the issue is confirmed to be with signature verification. Check:

1. **Region mismatch**: Ensure `AWS_REGION` environment variable matches your actual region
2. **Public key URL**: Verify the ALB public key endpoint is accessible
3. **Token format**: Check if the JWT token format is standard

## Technical Details

### ALB OIDC JWT Structure

ALB provides OIDC data in the `x-amzn-oidc-data` header as a JWT with:

- **Algorithm**: ES256 (ECDSA with P-256 curve)
- **Signature Format**: IEEE P1363 (64 bytes: 32-byte r + 32-byte s)
- **Public Key**: Available at `https://public-keys.auth.elb.{region}.amazonaws.com/{kid}`

### Node.js Crypto Verification

Node.js `crypto.verify()` supports multiple signature encodings:

- `'der'` (default): ASN.1 DER-encoded signature
- `'ieee-p1363'`: Raw r||s concatenation (what ALB uses)

The fix explicitly specifies `dsaEncoding: 'ieee-p1363'` when verifying ECDSA signatures from ALB.

## Security Considerations

1. **Never disable signature verification in production**
2. **Always validate token expiration** (`exp` claim)
3. **Always validate issuer** (`iss` claim)
4. **Always check for ALB-specific headers** (`x-amzn-oidc-accesstoken`)
5. **Cache public keys** to reduce latency and API calls

## References

- [AWS ALB OIDC Documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
- [Node.js Crypto Verify](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-options)
- [ECDSA Signature Formats](https://www.rfc-editor.org/rfc/rfc7518#section-3.4)
- [IEEE P1363 Standard](https://standards.ieee.org/standard/1363-2000.html)

## Rollback Plan

If issues persist, you can temporarily disable OIDC authentication:

**In `cdk/cdk.json`**:

```json
{
  "cloudtak": {
    "oidcEnabled": false
  }
}
```

Redeploy to fall back to password-based authentication.
