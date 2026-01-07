# Admin Environment Variables Patch (000)

## Overview
This patch adds support for configuring CloudTAK server settings via environment variables, based on upstream PR #712.

## Changes
- Adds `CLOUDTAK_Server_*` environment variable support for server configuration
- Adds support for P12 certificate loading from AWS Secrets Manager
- Adds VPC-related configuration (VpcId, SubnetPublicA, SubnetPublicB, MediaSecurityGroup)
- Adds MediaSecret and DynamoDB configuration

## Modifications from PR #712
- **Removed Cacher references**: PR #712 references `./cacher.js` which doesn't exist in upstream. These references have been removed from our patch.

## Known TypeScript Errors
The following TypeScript errors are expected and will be resolved when upstream merges related PRs:
- `lib/config.ts(195,51)`: Server generation with Record<string, unknown>
- `lib/config.ts(343,45)`: Profile generation with password in auth

These errors don't affect runtime functionality.

## Upstream Status
- Based on: [PR #712](https://github.com/dfpc-coe/CloudTAK/pull/712)
- Status: Not yet merged
- Note: Once PR #712 is merged, this patch can be removed

## Usage
Environment variables can be set to configure the server:
```bash
CLOUDTAK_Server_name="Production Server"
CLOUDTAK_Server_url="ssl://tak.example.com:8089"
CLOUDTAK_Server_api="https://tak.example.com:8443"
CLOUDTAK_Server_webtak="https://tak.example.com:8444"
CLOUDTAK_Server_auth_p12_secret_arn="arn:aws:secretsmanager:..."
CLOUDTAK_Server_auth_password="password"
```
