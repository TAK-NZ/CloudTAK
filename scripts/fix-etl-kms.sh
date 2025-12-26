#!/bin/bash
# Fix ETL Lambda functions to use BaseInfra KMS key instead of AWS-managed default
# This is needed after ETL role updates that change KMS permissions

REGION="${AWS_REGION:-us-west-2}"
STACK_NAME="${STACK_NAME:-TAK-Demo}"

# Get BaseInfra KMS key ARN
KMS_KEY_ARN=$(aws cloudformation list-exports --region "$REGION" --query "Exports[?Name==\`${STACK_NAME}-BaseInfra-KmsKeyArn\`].Value" --output text)

if [ -z "$KMS_KEY_ARN" ]; then
    echo "Error: Could not find BaseInfra KMS key ARN"
    exit 1
fi

echo "Using KMS Key: $KMS_KEY_ARN"

# Get all ETL layer Lambda functions
FUNCTIONS=$(aws lambda list-functions --region "$REGION" --query "Functions[?starts_with(FunctionName, \`${STACK_NAME}-CloudTAK-layer-\`)].FunctionName" --output text)

for FUNCTION in $FUNCTIONS; do
    echo "Updating $FUNCTION..."
    aws lambda update-function-configuration \
        --function-name "$FUNCTION" \
        --region "$REGION" \
        --kms-key-arn "$KMS_KEY_ARN" \
        --output json > /dev/null
    
    if [ $? -eq 0 ]; then
        echo "  ✓ Updated successfully"
    else
        echo "  ✗ Failed to update"
    fi
done

echo "Done!"
