# Upstream CloudFormation → CDK Implementation Guide

Upstream v13.26.0 introduced a number of CloudFormation changes (in `cloudformation/`) that need
to be reflected in the TAK-NZ CDK stack (`cdk/`). This document describes what each change is,
why it matters, and exactly how to implement it.

Reference diff: `git diff v12.47.2 v13.26.0 -- cloudformation/`

---

## Audit Status

_Last audited against CDK codebase on 2026-06-30._

| # | Change | Priority | Breaking | CDK Status |
|---|--------|----------|----------|------------|
| 1 | IAM S3 least-privilege | High | No | ⚠️ Partial |
| 2 | `cloudformation:ListStacks` | High | No | ❌ Missing |
| 3 | EventBridge tag permissions | High | No | ❌ Missing |
| 4 | GeofenceSecret + env var | High | No | ⚠️ Partial |
| 5 | ECS service name | Low | **Yes** | ✅ Done |
| 6 | KMS key rotation | Medium | No | ⬜ Out of scope (base-infra) |
| 7 | S3 encryption + public access block | Medium | No | ✅ Done |
| 8 | RDS security group IPv6 | Low | No | ❌ Missing |
| 9 | PMTiles API GW v1 → v2 | High | **Yes** | ❌ Not done |
| 10 | Lambda Node 20 → 24 | Medium | No | ❌ Missing |
| 11 | Events auto-scaling + fixed CPU/mem | Medium | No | ❌ Missing |
| 12 | Retention service (new) | Medium | No | ❌ Missing |
| 13 | Webhooks API GW v1 → v2 | Conditional | **Yes** | ✅ Done |

### Status key

- ✅ **Done** — already implemented in the CDK codebase, no action required
- ⚠️ **Partial** — partially implemented; remaining gaps noted in each section
- ❌ **Missing / Not done** — not yet implemented
- ⬜ **Out of scope** — the resource is owned by another stack (e.g. base-infra); needs action there

### Suggested implementation order

1. **Changes 2, 3, 8, 10** — all low-effort, non-breaking, do together in one PR
2. **Changes 1 & 4** — S3 tightening + GeofenceSecret wiring, one PR
3. **Change 11** — Events auto-scaling, one PR
4. **Change 9** — PMTiles v1→v2 (plan a maintenance window), one PR
5. **Change 12** — Retention service, one PR
6. **Change 6** — Raise with base-infra maintainers to enable KMS key rotation

---

## 1. IAM: Tighten S3 permissions on API and Events task roles

> **CDK Status: ⚠️ Partial**
>
> `cloudtak-api.ts`: Already uses specific actions (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`,
> `s3:ListBucket`, `s3:GetBucketLocation`) — not a wildcard. However `s3:AbortMultipartUpload` and
> `s3:ListMultipartUploadParts` are missing, and the bucket-level / object-level actions are not
> split into separate statements.
>
> `events-service.ts`: Still uses `actions: ['s3:*']` — **needs to be replaced**.

**Source file:** `cloudformation/lib/api.js`, `cloudformation/lib/events.js`  
**Priority:** High (security)  
**Breaking:** No

### What changed

Replaced `Action: '*'` on the S3 bucket with the minimum required set, and correctly split bucket-level
from object-level permissions:

```
Bucket-level  arn:…:s3:::${AssetBucket}         s3:ListBucket
Object-level  arn:…:s3:::${AssetBucket}/*        s3:GetObject, s3:PutObject, s3:DeleteObject,
                                                  s3:AbortMultipartUpload, s3:ListMultipartUploadParts
```

The Events task role also received the same treatment (minus `s3:ListBucket`).

### How to implement in CDK

Find the IAM policy statements on the API task role and Events task role in `cdk/lib/constructs/cloudtak-api.ts`
and `cdk/lib/constructs/events-service.ts` (or wherever task roles are defined).

Replace any existing wildcard S3 statement with two separate statements:

```typescript
// API task role - bucket level
new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:ListBucket'],
    resources: [`arn:aws:s3:::${assetBucketName}`],
}),
// API task role - object level
new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
    ],
    resources: [`arn:aws:s3:::${assetBucketName}/*`],
}),
```

For the Events task role, replace `s3:*` with the object-level actions only (omit `s3:ListBucket`):

```typescript
new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
    ],
    resources: [`arn:aws:s3:::${assetBucketName}/*`],
}),
```

---

## 2. IAM: Add `cloudformation:ListStacks` to API task role

> **CDK Status: ❌ Missing**
>
> `cloudtak-api.ts` has `cloudformation:DescribeStacks`, `ListExports`, `CreateStack`, etc., but
> `cloudformation:ListStacks` is absent. All existing CloudFormation actions are scoped to specific
> stack ARNs; `ListStacks` requires `Resource: *`.

**Source file:** `cloudformation/lib/api.js`  
**Priority:** High (functional — layer stack management broken without this)  
**Breaking:** No

### What changed

Added a new IAM statement to the API task role:

```json
{
    "Effect": "Allow",
    "Action": ["cloudformation:ListStacks"],
    "Resource": "*"
}
```

### How to implement in CDK

Add a `PolicyStatement` to the API task role in `cdk/lib/constructs/cloudtak-api.ts`:

```typescript
new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['cloudformation:ListStacks'],
    resources: ['*'],
}),
```

---

## 3. IAM: EventBridge tag permissions on API task role

> **CDK Status: ❌ Missing**
>
> `cloudtak-api.ts` EventBridge statement has `events:PutRule`, `events:PutTargets`,
> `events:DeleteRule`, `events:RemoveTargets`, `events:DescribeRule`. The three tag-management
> actions (`UntagResource`, `TagResource`, `ListTagsForResource`) are not present.

**Source file:** `cloudformation/lib/api.js`  
**Priority:** High (functional — EventBridge rule management incomplete without these)  
**Breaking:** No

### What changed

Three new EventBridge actions added to the existing EventBridge policy block:

- `events:UntagResource`
- `events:TagResource`
- `events:ListTagsForResource`

### How to implement in CDK

Find the existing EventBridge policy statement on the API task role in `cdk/lib/constructs/cloudtak-api.ts`
and add the three new actions alongside the existing ones:

```typescript
new cdk.aws_iam.PolicyStatement({
    effect: cdk.aws_iam.Effect.ALLOW,
    actions: [
        'events:PutRule',
        'events:PutTargets',
        'events:DeleteRule',
        'events:RemoveTargets',
        'events:DescribeRule',
        'events:UntagResource',       // ← add
        'events:TagResource',         // ← add
        'events:ListTagsForResource', // ← add
    ],
    resources: [`arn:...rule/TAK-${envConfig.stackName}-CloudTAK-layer-*`]
}),
```

---

## 4. ECS: GeofenceSecret — new secret + env var

> **CDK Status: ⚠️ Partial**
>
> `cdk/lib/constructs/secrets.ts`: `GeofenceSecret` **is** created with the correct name
> (`TAK-${envConfig.stackName}-CloudTAK/api/geofence`). ✅
>
> `cdk/lib/cloudtak-stack.ts`: `secrets.geofenceSecret` is **not** passed to `CloudTakApi` props. ❌
>
> `cdk/lib/constructs/cloudtak-api.ts`: No `CLOUDTAK_Config_geofence_password` env var injected
> into the API container, and no `grantRead` call on the secret. ❌

**Source file:** `cloudformation/lib/api.js`  
**Priority:** High (functional — geofence feature broken without this)  
**Breaking:** No (additive)

### What changed

1. A new Secrets Manager secret `GeofenceSecret` is created (key path: `${StackName}/api/geofence`)
2. The ECS `TaskDefinition` gains `DependsOn: ['SigningSecret', 'GeofenceSecret']`
3. A new environment variable is injected into the API container:
   ```
   CLOUDTAK_Config_geofence_password = {{resolve:secretsmanager:${StackName}/api/geofence}}
   ```

### How to implement in CDK

The secret already exists. The remaining work is three steps:

**Step 1** — Add `geofenceSecret` to `CloudTakApiProps` in `cloudtak-api.ts` and pass it from
`cloudtak-stack.ts`:

```typescript
// In CloudTakApiProps interface:
geofenceSecret: secretsmanager.ISecret;

// In cloudtak-stack.ts CloudTakApi constructor call:
geofenceSecret: secrets.geofenceSecret,
```

**Step 2** — Grant read access and inject env var in `cloudtak-api.ts`:

```typescript
// Grant access (alongside other secret grants)
props.geofenceSecret.grantRead(executionRole);

// In the container environment secrets map:
secrets: {
    'SigningSecret': ecs.Secret.fromSecretsManager(signingSecret),
    'POSTGRES': ecs.Secret.fromSecretsManager(connectionStringSecret),
    'CLOUDTAK_Config_geofence_password': ecs.Secret.fromSecretsManager(props.geofenceSecret), // ← add
    // ...
}
```

**Step 3** — CDK handles dependency ordering automatically when you use `ecs.Secret.fromSecretsManager()`,
so no explicit `addDependency` call is needed.

---

## 5. ECS: Service name change

> **CDK Status: ✅ Done**
>
> `cloudtak-api.ts` already uses `serviceName: \`TAK-${envConfig.stackName}-CloudTAK\`` — no
> `-Service` suffix. This is consistent with the upstream change direction. No action required.

**Source file:** `cloudformation/lib/api.js`  
**Priority:** Low — **implement with caution**  
**Breaking:** ⚠️ YES — triggers service replacement (brief outage)

### What changed

```diff
- ServiceName: ${StackName}-Service
+ ServiceName: ${StackName}
```

### How to implement in CDK

Already done. For reference, the CDK service name is set in `cdk/lib/constructs/cloudtak-api.ts`:

```typescript
this.service = new ecs.FargateService(this, 'Service', {
    serviceName: `TAK-${envConfig.stackName}-CloudTAK`, // ← already correct
    // ...
});
```

---

## 6. KMS: Enable annual key rotation

> **CDK Status: ⬜ Out of scope (base-infra)**
>
> The CloudTAK CDK stack does not own the KMS key — it imports it via
> `kms.Key.fromKeyArn(...)` from a `base-infra` export. The `enableKeyRotation` property
> can only be set on a key you own. **This change must be made in the base-infra stack.**

**Source file:** `cloudformation/lib/kms.js`  
**Priority:** Medium (security best practice)  
**Breaking:** No

### What changed

```diff
- EnableKeyRotation: false
+ EnableKeyRotation: true
```

### How to implement

Find the KMS key construct in the **base-infra** CDK/CloudFormation stack and set
`enableKeyRotation: true` (or `EnableKeyRotation: true`):

```typescript
// In base-infra stack:
const kmsKey = new kms.Key(this, 'KMS', {
    enableKeyRotation: true,  // ← add/change this
    description: stackName,
    enabled: true,
});
```

AWS rotates key material annually while preserving the same key ARN and alias — no application
changes required.

---

## 7. S3: Public access block and AES256 encryption on asset bucket

> **CDK Status: ✅ Done**
>
> `cdk/lib/constructs/s3-resources.ts` already sets `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL`
> and `encryption: s3.BucketEncryption.KMS` (which is stronger than upstream's AES256). No action
> required. Consider adding `enforceSSL: true` as an optional hardening step.

**Source file:** `cloudformation/lib/s3.js`  
**Priority:** Medium (security hardening)  
**Breaking:** No

### What changed

Added `PublicAccessBlockConfiguration` (all four settings `true`) and `BucketEncryption` (AES256)
to the asset bucket definition.

### How to implement in CDK

Already done. For reference, `s3-resources.ts` has:

```typescript
const assetBucket = new s3.Bucket(this, 'AssetBucket', {
    encryption: s3.BucketEncryption.KMS,             // ✅ stronger than upstream AES256
    encryptionKey: kmsKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // ✅ all 4 settings
    // Optional hardening (not yet set):
    // enforceSSL: true,
});
```

---

## 8. RDS security group: Add IPv6 ingress rule

> **CDK Status: ❌ Missing**
>
> `cdk/lib/constructs/security-groups.ts` imports `vpcCidrIpv6` and uses it for ECS outbound
> rules, but the **database** security group only has one ingress rule:
> `this.ecs → Port.tcp(5432)`. No IPv6 ingress rule exists on the database SG.

**Source file:** `cloudformation/lib/db.js`  
**Priority:** Low  
**Breaking:** No

### What changed

Added a second ingress rule to the RDS security group for IPv6:

```json
{
    "IpProtocol": "TCP",
    "FromPort": 5432,
    "ToPort": 5432,
    "CidrIpv6": "<vpc-ipv6-cidr>",
    "Description": "Allow Internal IPv6 network access"
}
```

### How to implement in CDK

In `cdk/lib/constructs/security-groups.ts`, add a second ingress rule to `this.database`
(the `vpcCidrIpv6` variable is already imported in that file):

```typescript
// Existing rule:
this.database.addIngressRule(this.ecs, ec2.Port.tcp(5432), 'ECS to Database');

// Add this:
this.database.addIngressRule(
    ec2.Peer.ipv6(vpcCidrIpv6),
    ec2.Port.tcp(5432),
    'Allow Internal IPv6 network access',
);
```

**Pre-condition:** Verify that the base-infra stack exports `tak-vpc-${env}-vpc-cidr-ipv6`. If it
does not export this value, skip this change.

```bash
aws cloudformation list-exports \
  --region ap-southeast-2 \
  --profile tak-nz-demo \
  --query "Exports[?contains(Name, 'ipv6')]"
```

---

## 9. PMTiles: Migrate from API Gateway v1 (REST) to v2 (HTTP API)

> **CDK Status: ❌ Not done**
>
> `cdk/lib/constructs/lambda-functions.ts` still uses `apigateway.RestApi` (v1 REST API) with
> `PMTilesApiGatewayRole`, `apigateway.DomainName`, `apigateway.Deployment`, `apigateway.Stage`,
> and `apigateway.BasePathMapping`. The PMTiles Lambda also lacks the `API_URL` environment variable.

**Source file:** `cloudformation/lib/pmtiles.js`  
**Priority:** High (architecture — HTTP API is cheaper, simpler, and has built-in CORS)  
**Breaking:** ⚠️ YES — existing v1 API Gateway and its DNS mapping will be destroyed

### What changed

Complete replacement of the PMTiles API Gateway infrastructure:

| Removed (v1 REST API) | Added (v2 HTTP API) |
|---|---|
| `PMTilesApiGatewayRole` | `PMTilesLambdaAPIPermission` (Lambda permission) |
| `PMTilesApiDomain` | `PMTilesApiDomainV2` |
| `PMTilesApiMap` | `PMTilesApiMapV2` |
| `PMTilesLambdaAPI` | `PMTilesLambdaAPIV2` |
| `PMTilesLambdaAPIResource` | `PMTilesLambdaAPIIntegration` |
| `PMTilesAPIDeployment` | `PMTilesLambdaAPIRoute` (GET) |
| `PMtilesLambdaAPIStage` | `PMTilesLambdaAPIRoutePost` (POST) |
| `PMTilesLambdaAPIResourceGET` | `PMTilesAPIStage` (`$default`, auto-deploy) |
| `PMTilesLambdaAPIResourceOPIONS` | — (CORS handled natively by HTTP API) |

Also: `API_URL` env var added to the PMTiles Lambda.

### How to implement in CDK

Find the PMTiles API Gateway construct in `cdk/lib/constructs/lambda-functions.ts`.

**Step 1** — Replace `apigw.RestApi` with `apigwv2.HttpApi`:

```typescript
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const pmtilesApi = new apigwv2.HttpApi(this, 'PMTilesLambdaAPIV2', {
    apiName: stackName,
    disableExecuteApiEndpoint: true,
    corsPreflight: {
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization',
                       'X-Api-Key', 'X-Amz-Security-Token', 'X-Amz-User-Agent'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowOrigins: ['*'],
    },
});
```

**Step 2** — Add Lambda integration and routes:

```typescript
const integration = new apigwv2Integrations.HttpLambdaIntegration(
    'PMTilesIntegration', pmtilesLambda,
    { payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_1_0 }
);

pmtilesApi.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.GET], integration });
pmtilesApi.addRoutes({ path: '/{proxy+}', methods: [apigwv2.HttpMethod.POST], integration });
```

**Step 3** — Replace `apigw.DomainName` with `apigwv2.DomainName`:

```typescript
const domain = new apigwv2.DomainName(this, 'PMTilesApiDomainV2', {
    domainName: `tiles.map.${hostedZoneName}`,
    certificate: acmCert,
    endpointType: apigwv2.EndpointType.REGIONAL,
});

new apigwv2.ApiMapping(this, 'PMTilesApiMapV2', {
    api: pmtilesApi,
    domainName: domain,
    stage: pmtilesApi.defaultStage,
});
```

**Step 4** — Update the Route 53 alias target to use `domain.regionalDomainName` and
`domain.regionalHostedZoneId`.

**Step 5** — Add `API_URL` to the PMTiles Lambda environment:

```typescript
pmtilesFunction.addEnvironment(
    'API_URL',
    `https://map.${hostedZoneName}`
);
```

**Step 6** — Remove the old IAM role (`PMTilesApiGatewayRole`) — it was only needed for the v1
integration credentials. The v2 integration uses a Lambda resource-based policy instead, which
CDK adds automatically.

**Deployment note:** Existing tiles DNS (`tiles.map.{domain}`) will briefly resolve to nothing
during the swap. The v1 `PMTilesApiDomain` and v2 `PMTilesApiDomainV2` cannot coexist on the
same DNS name simultaneously, so perform this in a single stack update. Consider using a
maintenance window.

---

## 10. Lambda: Bump EFS cleanup runtime to Node.js 24

> **CDK Status: ❌ Missing**
>
> `cdk/lib/constructs/pmtiles-efs.ts` — `CleanupLambda` uses `lambda.Runtime.NODEJS_20_X`.
> One-line change required.

**Source file:** `cloudformation/lib/pmtiles.js`  
**Priority:** Medium (Node 20 EOL approaching)  
**Breaking:** No

### What changed

```diff
- Runtime: 'nodejs20.x'
+ Runtime: 'nodejs24.x'
```

### How to implement in CDK

In `cdk/lib/constructs/pmtiles-efs.ts`, update the cleanup Lambda runtime:

```typescript
this.cleanupLambda = new lambda.Function(this, 'CleanupLambda', {
    runtime: lambda.Runtime.NODEJS_24_X,  // ← was NODEJS_20_X
    // …
});
```

---

## 11. ECS Events: Auto-scaling + dedicated CPU/memory

> **CDK Status: ❌ Missing**
>
> `cdk/lib/constructs/events-service.ts` uses `envConfig.ecs.taskCpu` / `envConfig.ecs.taskMemory`
> for the Events task definition (same shared config as the API service). It should use fixed values
> of **1024 CPU / 2048 MB**. No auto-scaling is configured at all.

**Source file:** `cloudformation/lib/events.js`  
**Priority:** Medium (operational — prevents Events service saturation under load)  
**Breaking:** No

### What changed

1. Events task CPU/memory changed from the shared `ComputeCpu`/`ComputeMemory` parameters to
   fixed values: **1024 CPU / 2048 MB memory**
2. New auto-scaling resources added:
   - `EventsAutoScalingRole` — IAM role for Application Auto Scaling
   - `EventsScalableTarget` — registers the Events ECS service (min 1, max 10 tasks)
   - `EventsCPUScalingPolicy` — target-tracking on CPU (default target 70%)
   - `EventsMemoryScalingPolicy` — target-tracking on memory (default target 80%)

### How to implement in CDK

**Step 1** — Fix the Events task definition CPU/memory in `cdk/lib/constructs/events-service.ts`:

```typescript
const eventsTaskDef = new ecs.FargateTaskDefinition(this, 'EventsTaskDefinition', {
    cpu: 1024,           // ← was envConfig.ecs.taskCpu
    memoryLimitMiB: 2048, // ← was envConfig.ecs.taskMemory
    // …
});
```

**Step 2** — Add auto-scaling to the Events service:

```typescript
const eventsScaling = eventsService.autoScaleTaskCount({
    minCapacity: 1,
    maxCapacity: 10,
});

eventsScaling.scaleOnCpuUtilization('EventsCPUScaling', {
    targetUtilizationPercent: 70,
    scaleInCooldown: cdk.Duration.seconds(300),
    scaleOutCooldown: cdk.Duration.seconds(60),
});

eventsScaling.scaleOnMemoryUtilization('EventsMemoryScaling', {
    targetUtilizationPercent: 80,
    scaleInCooldown: cdk.Duration.seconds(300),
    scaleOutCooldown: cdk.Duration.seconds(60),
});
```

The CDK `autoScaleTaskCount()` method creates the `EventsScalableTarget` and required IAM role
automatically — no need to create them manually.

---

## 12. New: Retention service (scheduled ECS task)

> **CDK Status: ❌ Missing**
>
> No `RetentionService` construct exists in `cdk/lib/constructs/` and it is not referenced in
> `cdk/lib/cloudtak-stack.ts`. This is a net-new component to be built.

**Source file:** `cloudformation/lib/retention.js` (new file)  
**Priority:** Medium (functional — old data cleanup does not run without this)  
**Breaking:** No (additive)

### What changed

Entirely new component: a scheduled ECS Fargate task that runs daily (configurable) to clean up
expired data via the retention API. Resources created:

- `RetentionLogs` — CloudWatch log group
- `RetentionTaskRole` — IAM role with S3 `s3:DeleteObject` and Secrets Manager read access
- `RetentionTaskDefinition` — Fargate task (256 CPU / 512 MB)
- `RetentionSecurityGroup` — no ingress SG
- `RetentionEventsRole` — EventBridge IAM role with `ecs:RunTask` and `iam:PassRole`
- `RetentionSchedule` — EventBridge rule (default: `rate(1 day)`)

The container image is `retention-${GitSha}` from the shared ECR. In CDK this corresponds to
the `tasks/retention` Docker image.

### How to implement in CDK

**Step 1** — Build and publish a `RetentionDockerAsset`:

```typescript
const retentionImageAsset = new ecrAssets.DockerImageAsset(this, 'RetentionDockerAsset', {
    directory: '..',
    file: 'tasks/retention/Dockerfile',
    exclude: ['node_modules/**', '**/node_modules/**', 'cdk/**', /* … */],
});
```

**Step 2** — Create the task definition:

```typescript
const retentionTaskDef = new ecs.FargateTaskDefinition(this, 'RetentionTaskDefinition', {
    cpu: 256,
    memoryLimitMiB: 512,
    executionRole: execRole,
    taskRole: retentionTaskRole,
});

retentionTaskDef.addContainer('retention', {
    image: ecs.ContainerImage.fromDockerImageAsset(retentionImageAsset),
    command: ['npm', 'run', 'run-once'],
    environment: {
        POSTGRES: postgresConnectionString,
        StackName: stackName,
        ASSET_BUCKET: assetBucket.bucketName,
        API_URL: `https://map.${hostedZoneName}`,
        AWS_REGION: this.region,
    },
    logging: ecs.LogDrivers.awsLogs({
        logGroup: retentionLogGroup,
        streamPrefix: stackName,
    }),
});
```

**Step 3** — Create the task role with the required permissions:

```typescript
const retentionTaskRole = new iam.Role(this, 'RetentionTaskRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
});
retentionTaskRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:DeleteObject'],
    resources: [`${assetBucket.bucketArn}/*`],
}));
retentionTaskRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:Describe*', 'secretsmanager:Get*', 'secretsmanager:List*'],
    resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${stackName}/*`],
}));
```

**Step 4** — Schedule via EventBridge:

```typescript
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

const retentionSchedule = new events.Rule(this, 'RetentionSchedule', {
    description: 'Schedule for CloudTAK retention runs',
    schedule: events.Schedule.rate(cdk.Duration.days(1)),
    enabled: true,
});

retentionSchedule.addTarget(new targets.EcsTask({
    cluster,
    taskDefinition: retentionTaskDef,
    launchType: ecs.LaunchType.FARGATE,
    platformVersion: ecs.FargatePlatformVersion.LATEST,
    securityGroups: [retentionSG],
    subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
    assignPublicIp: true,
}));
```

---

## 13. Webhooks: API Gateway v1 → v2 domain name resource

> **CDK Status: ✅ Done**
>
> `cdk/lib/constructs/webhooks.ts` already uses `apigatewayv2.CfnDomainName` with
> `domainNameConfigurations: [{ certificateArn, endpointType: 'REGIONAL' }]` throughout.
> No action required.

**Source file:** `cloudformation/webhooks.template.js`  
**Priority:** Depends on whether the webhooks stack is deployed  
**Breaking:** ⚠️ YES — triggers replacement of the domain name resource

### What changed

The webhooks API domain changed from `AWS::ApiGateway::DomainName` (v1) to
`AWS::ApiGatewayV2::DomainName` (v2), matching the same migration as PMTiles (#9):

```diff
- Type: 'AWS::ApiGateway::DomainName'
- RegionalCertificateArn: …
- EndpointConfiguration: { Types: ['REGIONAL'] }
+ Type: 'AWS::ApiGatewayV2::DomainName'
+ DomainNameConfigurations: [{ CertificateArn: …, EndpointType: 'REGIONAL' }]
```

### Current CDK implementation

Already correct in `cdk/lib/constructs/webhooks.ts`:

```typescript
this.domainName = new apigatewayv2.CfnDomainName(this, 'WebhooksDomain', {
    domainName: this.webhookUrl,
    domainNameConfigurations: [{
        certificateArn: certificate.certificateArn,
        endpointType: 'REGIONAL'
    }]
});
```
