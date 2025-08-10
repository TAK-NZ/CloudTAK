#!/bin/bash

set -e

echo "🔄 Applying commits from PR #712 (excluding docs)..."

# Use the main script with skip files
./scripts/apply-pr.sh 712 --skip-files docs/ENVIRONMENT_VARIABLES.md