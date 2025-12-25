# CloudTAK Webhooks Implementation

## Overview

The webhooks infrastructure provides incoming webhook support for CloudTAK layers, allowing external systems to push data directly to ETL layers via HTTP endpoints.

## Quick Reference

### URLs

| Environment | Webhook URL | CloudTAK URL |
|-------------|-------------|--------------|
| Test/Dev | `https://webhooks.test.tak.nz` | `https://map.test.tak.nz` |
| Production | `https://webhooks.tak.nz` | `https://map.tak.nz` |

### Health Check

```bash
curl https://webhooks.test.tak.nz/health
# Expected: 200 OK - "CloudTAK Webhooks API - Healthy"
```

### Test Deployment

```bash
./scripts/test-webhooks.sh Demo  # or Prod
```

## Architecture

```
External System → API Gateway V2 → Layer Lambda Function → CloudTAK Database
                      ↓
                 Custom Domain
         (webhooks.tak.nz or webhooks.test.tak.nz)
```

### Components

1. **API Gateway V2 HTTP API** - Receives webhook requests
2. **Custom Domain** - Provides branded webhook URLs (e.g., `webhooks.tak.nz` for production, `webhooks.test.tak.nz` for test)
3. **IAM Role** - Allows API Gateway to invoke layer Lambda functions
4. **Health Check Lambda** - Provides `/health` endpoint for monitoring
5. **Route53 Record** - DNS mapping for custom domain

## How It Works

### Layer Registration

When a CloudTAK layer is created with `incoming.webhooks: true`, the CloudTAK API automatically:

1. Creates a Lambda function for the layer (e.g., `TAK-Prod-CloudTAK-layer-123`)
2. Registers webhook routes in API Gateway:
   - `ANY /{layer-uuid}` - Base webhook endpoint
   - `ANY /{layer-uuid}/{proxy+}` - Catch-all for sub-paths
3. Configures API Gateway integration to invoke the layer's Lambda function

### Request Flow

```typescript
// Example: Webhook POST to https://webhooks.tak.nz/abc-123-def/data
POST /abc-123-def/data
Host: webhooks.tak.nz
Content-Type: application/json

{
  "event": "sensor_reading",
  "value": 42
}

↓ API Gateway routes to layer Lambda based on UUID
↓ Lambda processes webhook payload
↓ Data stored in CloudTAK database
```

## CDK Implementation

### File Structure

```
cdk/lib/constructs/
└── webhooks.ts          # Webhooks infrastructure construct
```

### Key Resources Created

| Resource | Purpose |
|----------|---------|
| `apigatewayv2.CfnApi` | HTTP API for webhook endpoints |
| `apigatewayv2.CfnDomainName` | Custom domain configuration |
| `iam.Role` | API Gateway execution role |
| `lambda.Function` | Health check endpoint |
| `route53.ARecord` | DNS record for custom domain |

### CloudFormation Exports

The construct exports these values for layer integration:

| Export Name | Value | Used By |
|-------------|-------|---------|
| `TAK-{Env}-CloudTAK-webhooks` | `https://webhooks.tak.nz` | Layer webhook URL construction |
| `TAK-{Env}-CloudTAK-webhooks-role` | IAM Role ARN | Layer Lambda integration permissions |
| `TAK-{Env}-CloudTAK-webhooks-api` | API Gateway ID | Layer route registration |

## Configuration

### Default Configuration

The webhooks subdomain defaults to `webhooks` but can be customized:

```json
// cdk/cdk.json
{
  "context": {
    "dev-test": {
      "cloudtak": {
        "hostname": "map",
        "webhooksSubdomain": "webhooks"  // Optional, defaults to "webhooks"
      }
    }
  }
}
```

### Environment-Specific URLs

| Environment | CloudTAK URL | Webhooks URL |
|-------------|--------------|--------------|
| Test/Dev | `map.test.tak.nz` | `webhooks.test.tak.nz` |
| Production | `map.tak.nz` | `webhooks.tak.nz` |

**Note:** The webhook domain automatically uses the same hosted zone as your CloudTAK deployment.

## Layer Integration

### API Code Reference

The CloudTAK API automatically integrates with webhooks when creating layers. See `api/lib/aws/lambda.ts`:

```typescript
// When layer.incoming.webhooks is true, the API adds:
if (layer.incoming.webhooks) {
    stack.Resources.WebHookResourceBase = {
        Type: 'AWS::ApiGatewayV2::Route',
        Properties: {
            RouteKey: cf.join(['ANY /', cf.ref('UniqueID')]),
            ApiId: cf.importValue(config.StackName.replace(/^tak-cloudtak-/, 'tak-cloudtak-webhooks-') + '-api'),
            Target: cf.join(['integrations/', cf.ref('WebHookResourceIntegration')])
        }
    };
    
    // ... additional webhook resources
}
```

### Layer Configuration Example

```json
{
  "name": "Weather Station Webhook",
  "task": "etl-weather-v1.0.0",
  "incoming": {
    "webhooks": true
  }
}
```

This creates webhook endpoints:
- `https://webhooks.tak.nz/{layer-uuid}`
- `https://webhooks.tak.nz/{layer-uuid}/readings`
- `https://webhooks.tak.nz/{layer-uuid}/alerts`

## Security

### IAM Permissions

The API Gateway role has minimal permissions:

```typescript
{
  "Effect": "Allow",
  "Action": ["lambda:InvokeFunction"],
  "Resource": [
    "arn:aws:lambda:region:account:function:TAK-Prod-CloudTAK-layer-*"
  ]
}
```

### Authentication

Webhook authentication is handled by the layer Lambda function itself. Common patterns:

1. **API Key** - Layer validates `X-API-Key` header
2. **HMAC Signature** - Layer verifies request signature
3. **IP Allowlist** - Layer checks source IP
4. **Bearer Token** - Layer validates JWT token

## Monitoring

### Health Check

```bash
curl https://webhooks.tak.nz/health  # production
curl https://webhooks.test.tak.nz/health  # test/dev
# Response: 200 OK - "CloudTAK Webhooks API - Healthy"
```

### CloudWatch Metrics

API Gateway automatically publishes metrics:
- `Count` - Number of requests
- `4XXError` - Client errors
- `5XXError` - Server errors
- `Latency` - Request duration

### Layer-Specific Alarms

Each layer has its own CloudWatch alarms (configured in `api/lib/aws/lambda.ts`):
- Lambda errors
- Lambda invocation count
- SQS queue backlog (if using outgoing queues)

## Deployment

### Initial Deployment

```bash
# Deploy with webhooks enabled (default)
npm run deploy:dev
npm run deploy:prod
```

### Custom Subdomain

```bash
# Override webhooks subdomain
npm run deploy:dev -- --context webhooksSubdomain=hooks
# Creates: hooks.test.tak.nz (or hooks.{your-hosted-zone})
```

### Verification

```bash
# Check CloudFormation exports
aws cloudformation list-exports \
  --query "Exports[?contains(Name, 'webhooks')]"

# Test health endpoint
curl https://webhooks.test.tak.nz/health
```

## Troubleshooting

### Issue: Webhook returns 403 Forbidden

**Cause:** API Gateway role lacks permission to invoke layer Lambda

**Solution:**
```bash
# Check role permissions
aws iam get-role-policy \
  --role-name TAK-Prod-CloudTAK-webhooks-apigw \
  --policy-name default

# Verify Lambda function exists
aws lambda get-function \
  --function-name TAK-Prod-CloudTAK-layer-123
```

### Issue: Webhook returns 404 Not Found

**Cause:** Layer routes not registered in API Gateway

**Solution:**
```bash
# Check API Gateway routes
aws apigatewayv2 get-routes \
  --api-id <api-id> \
  --query 'Items[*].RouteKey'

# Verify layer has webhooks enabled
# Check layer.incoming.webhooks in database
```

### Issue: Custom domain not resolving

**Cause:** Route53 record not created or DNS propagation delay

**Solution:**
```bash
# Check Route53 record
aws route53 list-resource-record-sets \
  --hosted-zone-id <zone-id> \
  --query "ResourceRecordSets[?Name=='webhooks.tak.nz.']"

# Test DNS resolution
dig webhooks.tak.nz
nslookup webhooks.tak.nz
```

## Cost Estimation

### API Gateway V2 HTTP API

- **Requests:** $1.00 per million requests
- **Data Transfer:** $0.09/GB (first 10TB)

### Example Monthly Costs

| Webhook Volume | API Gateway Cost | Lambda Cost* | Total |
|----------------|------------------|--------------|-------|
| 1M requests/month | $1.00 | ~$0.20 | ~$1.20 |
| 10M requests/month | $10.00 | ~$2.00 | ~$12.00 |
| 100M requests/month | $100.00 | ~$20.00 | ~$120.00 |

*Lambda costs assume 128MB memory, 100ms duration per request

## Future Enhancements

### Potential Improvements

1. **Rate Limiting** - Add API Gateway throttling per layer
2. **Request Validation** - Schema validation at API Gateway level
3. **Caching** - Enable API Gateway caching for GET requests
4. **WAF Integration** - Add AWS WAF for DDoS protection
5. **Custom Authorizers** - Centralized authentication at API Gateway
6. **Metrics Dashboard** - CloudWatch dashboard for webhook analytics

## Command Reference

### CloudFormation Exports

```bash
# List all webhook exports
aws cloudformation list-exports \
  --query "Exports[?contains(Name, 'webhooks')]"

# Get webhook URL
aws cloudformation list-exports \
  --query "Exports[?Name=='TAK-Demo-CloudTAK-webhooks'].Value" \
  --output text

# Get API Gateway ID
aws cloudformation list-exports \
  --query "Exports[?Name=='TAK-Demo-CloudTAK-webhooks-api'].Value" \
  --output text
```

### Monitor Layer Webhooks

```bash
# Tail Lambda logs for layer
aws logs tail /aws/lambda/TAK-Demo-CloudTAK-layer-123 --follow

# Get recent errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/TAK-Demo-CloudTAK-layer-123 \
  --filter-pattern "ERROR"
```

### API Gateway Management

```bash
# Get API Gateway ID
API_ID=$(aws cloudformation list-exports \
  --query "Exports[?Name=='TAK-Demo-CloudTAK-webhooks-api'].Value" \
  --output text)

# List routes
aws apigatewayv2 get-routes --api-id $API_ID

# Get API details
aws apigatewayv2 get-api --api-id $API_ID
```
