# TODO: ArcGIS Authentication Implementation

## Overview
Implement dual authentication mechanisms for ArcGIS geocoding and routing APIs with admin configuration support.

## Authentication Methods

### 1. OAuth 2.0 Client Credentials (ArcGIS Location Platform & Enterprise)
- **Endpoint**: `https://www.arcgis.com/sharing/rest/oauth2/token`
- **Method**: POST
- **Parameters**:
  - `client_id`: OAuth client ID
  - `client_secret`: OAuth client secret
  - `grant_type`: "client_credentials"
  - `f`: "json"
- **Usage**: `?token=<OAUTH_TOKEN>` parameter in API calls
- **Benefits**: More secure, no user credentials stored, industry standard
- **Token Expiration**: Typically longer-lived than user tokens
- **Supported Platforms**: ArcGIS Location Platform, ArcGIS Enterprise

### 2. Legacy Token Authentication (Pre-generated Token)
- **Method**: Direct token usage (no generation endpoint)
- **Usage**: `?token=<LEGACY_TOKEN>` parameter in API calls
- **Token Source**: Pre-generated token provided by admin
- **Token Expiration**: Varies (typically long-lived)
- **Supported Platforms**: ArcGIS Enterprise, older ArcGIS implementations
- **Benefits**: Simple configuration, no credential storage required

## Implementation Tasks

### 1. Token Manager Class
- [ ] Create `ArcGISTokenManager` class
- [ ] Implement OAuth 2.0 client credentials flow
- [ ] Support direct legacy token configuration (no generation needed)
- [ ] Add automatic token refresh (90% of expiration time)
- [ ] Handle token refresh failures with exponential backoff
- [ ] Store tokens with expiration timestamps
- [ ] Provide `getValidToken()` method

### 2. Update Geocode Class
- [ ] Modify constructor to accept token manager instance
- [ ] Update all methods to use `token` parameter consistently (remove `apikey` usage)
- [ ] Change all authentication to use `url.searchParams.append('token', this.token)`
- [ ] Update routing method to use `token` parameter instead of form data
- [ ] Add error handling for 498/499 authentication errors
- [ ] Implement automatic token refresh on auth failures

### 3. Admin Configuration Interface
- [ ] Add ArcGIS authentication section to admin config page
- [ ] Create authentication method selector (OAuth2 vs Legacy)
- [ ] Add OAuth 2.0 configuration fields:
  - Client ID (text input)
  - Client Secret (password input, encrypted storage)
- [ ] Add Legacy token configuration fields:
  - Token Value (password input, encrypted storage)
- [ ] Add token status display (current token, expiration time)
- [ ] Add "Test Connection" button for validation
- [ ] Store credentials securely (encrypted in database)

### 4. Database Schema Updates
- [ ] Add `arcgis_auth_method` enum field ('oauth2', 'legacy')
- [ ] Add `arcgis_client_id` field
- [ ] Add `arcgis_client_secret` field (encrypted)
- [ ] Add `arcgis_legacy_token` field (encrypted)
- [ ] Add migration script

### 5. Environment Variables (Optional)
- [ ] Support environment variable configuration:
  - `ARCGIS_AUTH_METHOD`
  - `ARCGIS_CLIENT_ID`
  - `ARCGIS_CLIENT_SECRET`
  - `ARCGIS_LEGACY_TOKEN`

### 6. API Endpoints
- [ ] Update geocoding endpoints to use new token manager
- [ ] Update routing endpoints to use new token manager
- [ ] Add admin API endpoints for ArcGIS configuration
- [ ] Add token status/health check endpoint

### 7. Error Handling & Logging
- [ ] Log authentication method in use
- [ ] Log token refresh events
- [ ] Handle and log authentication failures
- [ ] Implement graceful degradation (disable features on auth failure)
- [ ] Add metrics for token refresh frequency

### 8. Testing
- [ ] Unit tests for token manager
- [ ] Integration tests for both auth methods
- [ ] Admin interface testing
- [ ] Token refresh testing
- [ ] Error handling testing

### 9. Documentation
- [ ] Update API documentation
- [ ] Add admin configuration guide
- [ ] Document authentication troubleshooting
- [ ] Add security best practices guide

## Configuration Priority
1. Database configuration (admin interface)
2. Environment variables
3. Default values (OAuth2 preferred)

## Authentication Method Support

| Service | OAuth Token | Legacy Token | Notes |
|---------|-------------|--------------|-------|
| Reverse Geocoding | ✅ | ✅ | Both use `?token=` parameter |
| Suggest API | ✅ | ✅ | Both use `?token=` parameter |
| Forward Geocoding | ✅ | ✅ | Both use `?token=` parameter |
| Routing API | ✅ | ✅ | Both use `?token=` parameter |

**Note**: All services use the same `?token=` parameter format. The difference is in how the token is obtained (OAuth generation vs pre-configured legacy token).

## Security Considerations
- Encrypt sensitive credentials in database
- Use secure password inputs in admin interface
- Implement proper session management for admin access
- Log authentication events for audit trail
- Validate and sanitize all configuration inputs

## Testing Commands

### OAuth 2.0 Testing

#### 1. Generate OAuth Token
```bash
export OAUTH_TOKEN=$(curl -s -X POST "https://www.arcgis.com/sharing/rest/oauth2/token" \
  -d "client_id=<YOUR_CLIENT_ID>" \
  -d "client_secret=<YOUR_CLIENT_SECRET>" \
  -d "grant_type=client_credentials" \
  -d "f=json" | jq -r '.access_token')

echo "OAuth Token: $OAUTH_TOKEN"
```

#### 2. Test OAuth Token Validity
```bash
curl "https://www.arcgis.com/sharing/rest/portals/self?f=json&token=$OAUTH_TOKEN"
```

#### 3. OAuth API Endpoint Tests
```bash
# Reverse Geocoding
curl "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=-122.4194,37.7749&f=json&token=$OAUTH_TOKEN"

# Suggest API
curl "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?text=San%20Francisco&f=json&token=$OAUTH_TOKEN"

# Forward Geocoding
curl "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?singleLine=San%20Francisco&f=json&token=$OAUTH_TOKEN"

# Routing API
curl "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve?f=json&stops=-122.4194,37.7749;-122.4094,37.7849&token=$OAUTH_TOKEN"
```

### Legacy Token Testing

#### 1. Set Pre-configured Legacy Token
```bash
# Use your pre-generated legacy token
export LEGACY_TOKEN="your_pre_generated_legacy_token_here"

echo "Legacy Token: ${LEGACY_TOKEN:0:20}..."
```

#### 2. Test Legacy Token Validity
```bash
curl "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer?f=json&token=$LEGACY_TOKEN"
```

#### 3. Legacy API Endpoint Tests
```bash
# Reverse Geocoding
curl "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=-122.4194,37.7749&f=json&token=$LEGACY_TOKEN"

# Suggest API
curl "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?text=San%20Francisco&f=json&token=$LEGACY_TOKEN"

# Forward Geocoding
curl "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?singleLine=San%20Francisco&f=json&token=$LEGACY_TOKEN"

# Routing API
curl "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve?f=json&stops=-122.4194,37.7749;-122.4094,37.7849&token=$LEGACY_TOKEN"
```

### Manual Token Testing (Alternative)

#### Set tokens manually if needed:
```bash
# For OAuth token
export OAUTH_TOKEN="your_oauth_token_here"

# For Legacy token
export LEGACY_TOKEN="your_legacy_token_here"
```

### Error Response Examples

#### Invalid Token (498)
```json
{"error":{"code":498,"message":"Invalid Token","details":[]}}
```

#### Token Required (499)
```json
{"error":{"code":499,"message":"Token Required","details":[]}}
```

### Test Coordinates
- **San Francisco**: `-122.4194,37.7749`
- **New York**: `-74.0060,40.7128`
- **London**: `-0.1276,51.5074`

### Complete Test Script Example
```bash
#!/bin/bash

# OAuth 2.0 Testing
echo "=== OAuth 2.0 Testing ==="
export OAUTH_TOKEN=$(curl -s -X POST "https://www.arcgis.com/sharing/rest/oauth2/token" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  -d "f=json" | jq -r '.access_token')

if [ "$OAUTH_TOKEN" != "null" ] && [ -n "$OAUTH_TOKEN" ]; then
  echo "OAuth Token obtained: ${OAUTH_TOKEN:0:20}..."
  
  echo "Testing Reverse Geocoding..."
  curl -s "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=-122.4194,37.7749&f=json&token=$OAUTH_TOKEN" | jq '.address.LongLabel'
  
  echo "Testing Routing..."
  curl -s "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve?f=json&stops=-122.4194,37.7749;-122.4094,37.7849&token=$OAUTH_TOKEN" | jq '.routes.features[0].attributes.Name'
else
  echo "Failed to obtain OAuth token"
fi

# Legacy Token Testing
echo "\n=== Legacy Token Testing ==="
export LEGACY_TOKEN="YOUR_PRE_GENERATED_LEGACY_TOKEN"

if [ -n "$LEGACY_TOKEN" ]; then
  echo "Legacy Token set: ${LEGACY_TOKEN:0:20}..."
  
  echo "Testing Reverse Geocoding..."
  curl -s "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=-122.4194,37.7749&f=json&token=$LEGACY_TOKEN" | jq '.address.LongLabel'
  
  echo "Testing Routing..."
  curl -s "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World/solve?f=json&stops=-122.4194,37.7749;-122.4094,37.7849&token=$LEGACY_TOKEN" | jq '.routes.features[0].attributes.Name'
else
  echo "Legacy token not set"
fi
```