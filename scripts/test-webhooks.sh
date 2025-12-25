#!/bin/bash
# Test script for CloudTAK Webhooks Infrastructure
# Usage: ./test-webhooks.sh <stack-name>
# Example: ./test-webhooks.sh Demo

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <stack-name>"
    echo "Example: $0 Demo"
    echo "Example: $0 Prod"
    exit 1
fi

STACK_NAME="$1"
FULL_STACK_NAME="TAK-${STACK_NAME}-CloudTAK"

# Get webhook URL from CloudFormation exports
WEBHOOKS_URL=$(aws cloudformation list-exports \
    --query "Exports[?Name=='${FULL_STACK_NAME}-webhooks'].Value" \
    --output text 2>/dev/null)

if [ -z "$WEBHOOKS_URL" ] || [ "$WEBHOOKS_URL" = "None" ]; then
    echo "❌ Error: Could not find webhooks URL for stack ${FULL_STACK_NAME}"
    echo "   Make sure the stack is deployed and webhooks are enabled."
    exit 1
fi

echo "Testing CloudTAK Webhooks Infrastructure"
echo "Stack Name: $FULL_STACK_NAME"
echo "Webhooks URL: $WEBHOOKS_URL"
echo ""

# Test 1: Health Check
echo "Test 1: Health Check Endpoint"
echo "================================"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$WEBHOOKS_URL/health")
if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Health check passed (HTTP $HTTP_CODE)"
    curl -s "$WEBHOOKS_URL/health"
    echo ""
else
    echo "❌ Health check failed (HTTP $HTTP_CODE)"
    exit 1
fi
echo ""

# Test 2: CloudFormation Exports
echo "Test 2: CloudFormation Exports"
echo "================================"
EXPORTS=$(aws cloudformation list-exports \
    --query "Exports[?contains(Name, '${FULL_STACK_NAME}-webhooks')].[Name,Value]" \
    --output table)

if [ -n "$EXPORTS" ]; then
    echo "✅ CloudFormation exports found:"
    echo "$EXPORTS"
else
    echo "❌ No CloudFormation exports found"
    exit 1
fi
echo ""

# Test 3: API Gateway Configuration
echo "Test 3: API Gateway Configuration"
echo "================================"
API_ID=$(aws cloudformation list-exports \
    --query "Exports[?Name=='${FULL_STACK_NAME}-webhooks-api'].Value" \
    --output text)

if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
    echo "✅ API Gateway ID: $API_ID"
    
    # Get API details
    API_ENDPOINT=$(aws apigatewayv2 get-api \
        --api-id "$API_ID" \
        --query 'ApiEndpoint' \
        --output text)
    echo "   API Endpoint: $API_ENDPOINT"
    
    # List routes
    echo "   Routes:"
    aws apigatewayv2 get-routes \
        --api-id "$API_ID" \
        --query 'Items[*].[RouteKey,Target]' \
        --output table | sed 's/^/   /'
else
    echo "❌ API Gateway not found"
    exit 1
fi
echo ""

# Test 4: IAM Role
echo "Test 4: IAM Role Configuration"
echo "================================"
ROLE_ARN=$(aws cloudformation list-exports \
    --query "Exports[?Name=='${FULL_STACK_NAME}-webhooks-role'].Value" \
    --output text)

if [ -n "$ROLE_ARN" ] && [ "$ROLE_ARN" != "None" ]; then
    echo "✅ IAM Role ARN: $ROLE_ARN"
    
    ROLE_NAME=$(echo "$ROLE_ARN" | awk -F'/' '{print $NF}')
    
    # Check role policies
    echo "   Inline Policies:"
    aws iam list-role-policies \
        --role-name "$ROLE_NAME" \
        --query 'PolicyNames' \
        --output table | sed 's/^/   /'
else
    echo "❌ IAM Role not found"
    exit 1
fi
echo ""

# Test 5: DNS Resolution
echo "Test 5: DNS Resolution"
echo "================================"
DOMAIN=$(echo "$WEBHOOKS_URL" | sed 's|https://||')
DNS_RESULT=$(dig +short "$DOMAIN" A | head -1)

if [ -n "$DNS_RESULT" ]; then
    echo "✅ DNS resolves to: $DNS_RESULT"
else
    echo "⚠️  DNS not yet propagated (this may take a few minutes)"
fi
echo ""

# Test 6: SSL Certificate
echo "Test 6: SSL Certificate"
echo "================================"
SSL_INFO=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null)

if [ -n "$SSL_INFO" ]; then
    echo "✅ SSL Certificate valid:"
    echo "$SSL_INFO" | sed 's/^/   /'
else
    echo "⚠️  SSL certificate check failed (DNS may not be propagated yet)"
fi
echo ""

# Summary
echo "================================"
echo "Test Summary"
echo "================================"
echo "All critical tests passed! ✅"
echo ""
echo "Next Steps:"
echo "1. Create a CloudTAK layer with webhooks enabled"
echo "2. Test webhook endpoint: curl -X POST $WEBHOOKS_URL/{layer-uuid}/test"
echo "3. Monitor CloudWatch Logs for layer Lambda function"
echo ""
