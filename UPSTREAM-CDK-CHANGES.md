# Upstream CloudFormation → CDK Implementation Guide

Upstream v13.26.0 introduced a number of CloudFormation changes (in `cloudformation/`) that need
to be reflected in the TAK-NZ CDK stack (`cdk/`). This document describes what each change is,
why it matters, and exactly how to implement it.

Reference diff: `git diff v12.47.2 v13.26.0 -- cloudformation/`

---

## 1. IAM: Tighten S3 permissions on API and Events task roles

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

For the Events task role, omit `s3:ListBucket` (object-level actions only).

---

## 2. IAM: Add `cloudformation:ListStacks` to API task role

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

Add a `PolicyStatement` to the API task role:

```typescript
new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['cloudformation:ListStacks'],
    resources: ['*'],
}),
```

---

## 3. IAM: EventBridge tag permissions on API task role

**Source file:** `cloudformation/lib/api.js`  
**Priority:** High (functional — EventBridge rule management incomplete without these)  
**Breaking:** No

### What changed

Three new EventBridge actions added to the existing EventBridge policy block:

- `events:UntagResource`
- `events:TagResource`
- `events:ListTagsForResource`

### How to implement in CDK

Find the existing EventBridge policy statement on the API task role and add the three new actions
alongside the existing ones (`events:PutRule`, `events:DescribeRule`, etc.).

---

## 4. ECS: GeofenceSecret — new secret + env var

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

**Step 1** — Create the secret in `cdk/lib/cloudtak-stack.ts` (or wherever `SigningSecret` is created):

```typescript
const geofenceSecret = new secretsmanager.Secret(this, 'GeofenceSecret', {
    secretName: `${stackName}/api/geofence`,
    description: 'CloudTAK geofence service password',
    generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
    },
});
```

**Step 2** — Add it to the task definition dependency (if using L1 `CfnTaskDefinition`, add
`addDependency(geofenceSecret)`; with L2, CDK handles ordering automatically when you use
`ecs.Secret.fromSecretsManager()`).

**Step 3** — Inject as an environment variable on the API container:

```typescript
environment: {
    // existing vars …
    CLOUDTAK_Config_geofence_password: secretsmanager.Secret
        .fromSecretNameV2(this, 'GeofenceSecretRef', `${stackName}/api/geofence`)
        .secretValue.unsafeUnwrap(),
},
```

Or, safer — use the resolve syntax directly in the environment map if you're using L1 constructs:

```typescript
{ name: 'CLOUDTAK_Config_geofence_password',
  value: `{{resolve:secretsmanager:${stackName}/api/geofence}}` }
```

**Step 4** — Grant the API task role `secretsmanager:GetSecretValue` on the new secret.

---

## 5. ECS: Service name change

**Source file:** `cloudformation/lib/api.js`  
**Priority:** Low — **implement with caution**  
**Breaking:** ⚠️ YES — triggers service replacement (brief outage)

### What changed

```diff
- ServiceName: ${StackName}-Service
+ ServiceName: ${StackName}
```

### How to implement in CDK

Find the `serviceName` property on the CloudTAK API ECS Service construct and remove the `-Service`
suffix.

**Before deploying**, verify whether the live service currently has the old name:

```bash
aws ecs describe-services \
  --cluster TAK-Demo-BaseInfra \
  --services TAK-Demo-CloudTAK-Service \
  --region ap-southeast-2 \
  --profile tak-nz-demo \
  --query 'services[0].serviceName'
```

Because ECS service names are immutable, CloudFormation/CDK will **delete** the old service and
**create** a new one. Plan for a rolling deployment window. Ensure the load balancer health check
grace period is sufficient so the new service registers before the old one is fully drained.

---

## 6. KMS: Enable annual key rotation

**Source file:** `cloudformation/lib/kms.js`  
**Priority:** Medium (security best practice)  
**Breaking:** No

### What changed

```diff
- EnableKeyRotation: false
+ EnableKeyRotation: true
```

### How to implement in CDK

Find the KMS key construct in the CDK stack and set `enableKeyRotation: true`:

```typescript
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

**Source file:** `cloudformation/lib/s3.js`  
**Priority:** Medium (security hardening)  
**Breaking:** No

### What changed

Added `PublicAccessBlockConfiguration` (all four settings `true`) and `BucketEncryption` (AES256)
to the asset bucket definition.

### How to implement in CDK

The CDK L2 `s3.Bucket` construct applies these by default. Verify the existing bucket construct
has these set (or relies on CDK defaults) and add them explicitly if not:

```typescript
const assetBucket = new s3.Bucket(this, 'AssetBucket', {
    bucketName: `${stackName}-${this.account}-${this.region}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,  // ← ensures all 4 settings
    encryption: s3.BucketEncryption.S3_MANAGED,         // ← AES256
    enforceSSL: true,                                    // ← recommended alongside encryption
});
```

---

## 8. RDS security group: Add IPv6 ingress rule

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

**Pre-condition:** Verify that the base-infra stack exports `tak-vpc-${env}-vpc-cidr-ipv6`. If it
does not export this value, skip this change.

```bash
aws cloudformation list-exports \
  --region ap-southeast-2 \
  --profile tak-nz-demo \
  --query "Exports[?contains(Name, 'ipv6')]"
```

If the export exists, find the RDS security group in the CDK stack and add:

```typescript
dbSecurityGroup.addIngressRule(
    ec2.Peer.ipv6(
        Fn.importValue(`tak-vpc-${environment}-vpc-cidr-ipv6`)
    ),
    ec2.Port.tcp(5432),
    'Allow Internal IPv6 network access',
);
```

---

## 9. PMTiles: Migrate from API Gateway v1 (REST) to v2 (HTTP API)

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

Find the PMTiles API Gateway construct in `cdk/lib/constructs/` or `cdk/lib/cloudtak-stack.ts`.

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

**Source file:** `cloudformation/lib/pmtiles.js`  
**Priority:** Medium (Node 20 EOL approaching)  
**Breaking:** No

### What changed

```diff
- Runtime: 'nodejs20.x'
+ Runtime: 'nodejs24.x'
```

### How to implement in CDK

Find the EFS cleanup Lambda in the PMTiles construct and update:

```typescript
new lambda.Function(this, 'EFSCleanupLambda', {
    runtime: lambda.Runtime.NODEJS_24_X,  // ← was NODEJS_20_X
    // …
});
```

---

## 11. ECS Events: Auto-scaling + dedicated CPU/memory

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

**Step 1** — Fix the Events task definition CPU/memory:

```typescript
const eventsTaskDef = new ecs.FargateTaskDefinition(this, 'EventsTaskDefinition', {
    cpu: 1024,
    memoryLimitMiB: 2048,
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
    scaleInCooldown: Duration.seconds(300),
    scaleOutCooldown: Duration.seconds(60),
});

eventsScaling.scaleOnMemoryUtilization('EventsMemoryScaling', {
    targetUtilizationPercent: 80,
    scaleInCooldown: Duration.seconds(300),
    scaleOutCooldown: Duration.seconds(60),
});
```

The CDK `autoScaleTaskCount()` method creates the `EventsScalableTarget` and required IAM role
automatically — no need to create them manually.

---

## 12. New: Retention service (scheduled ECS task)

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
    schedule: events.Schedule.rate(Duration.days(1)),
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

### How to implement in CDK

**Pre-condition:** Check whether the webhooks stack is deployed for your environment:

```bash
aws cloudformation describe-stacks \
  --stack-name TAK-Demo-CloudTAK-Webhooks \
  --region ap-southeast-2 \
  --profile tak-nz-demo 2>&1 | grep StackStatus
```

If the webhooks stack is deployed, find the domain name construct and update it. The CDK L2
`apigwv2.DomainName` construct already uses the v2 resource type:

```typescript
// If using L1 CfnDomainName, replace with:
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

const webhooksDomain = new apigwv2.DomainName(this, 'CloudTAKWebhooksApiDomain', {
    domainName: `${subdomainPrefix}.${hostedZoneName}`,
    certificate: acmCert,
    endpointType: apigwv2.EndpointType.REGIONAL,
});
```

**Deployment note:** Same caution as change #9 — the old v1 domain resource will be deleted and
a new v2 resource created. Briefly, the subdomain DNS alias will be stale. Perform during a
low-traffic window.

---

## Summary

| # | Change | Priority | Breaking | Effort |
|---|--------|----------|----------|--------|
| 1 | IAM S3 least-privilege | High | No | Low |
| 2 | `cloudformation:ListStacks` | High | No | Low |
| 3 | EventBridge tag permissions | High | No | Low |
| 4 | GeofenceSecret + env var | High | No | Medium |
| 5 | ECS service name | Low | **Yes** | Low |
| 6 | KMS key rotation | Medium | No | Low |
| 7 | S3 encryption + public access block | Medium | No | Low |
| 8 | RDS security group IPv6 | Low | No | Low |
| 9 | PMTiles API GW v1 → v2 | High | **Yes** | High |
| 10 | Lambda Node 20 → 24 | Medium | No | Low |
| 11 | Events auto-scaling + fixed CPU/mem | Medium | No | Medium |
| 12 | Retention service (new) | Medium | No | High |
| 13 | Webhooks API GW v1 → v2 | Conditional | **Yes** | Medium |

**Suggested implementation order:**

1. Changes 1–3, 6–8, 10 — low-effort, non-breaking, do together in one PR
2. Change 4 (GeofenceSecret) — requires secret creation + migration, one PR
3. Change 11 (Events auto-scaling) — one PR
4. Change 9 (PMTiles v1→v2) — plan a maintenance window, one PR
5. Change 12 (Retention service) — one PR
6. Change 5 (service name) — plan a maintenance window, do last
7. Change 13 (Webhooks) — only if webhooks stack is deployed
