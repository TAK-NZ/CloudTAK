# Upstream CloudFormation → CDK Implementation Guide

Upstream CloudTAK ships its infrastructure as CloudFormation (`cloudformation/`). TAK.NZ maintains an
equivalent CDK stack (`cdk/`). Whenever we sync the application code to a newer upstream release, the
CloudFormation changes made in that range have to be re-implemented in CDK by hand.

This document covers the **v13.26.0 → v13.70.0** range, which is the CloudFormation half of the
in-progress application upgrade to v13.70.0.

Reference diff: `git diff v13.26.0 v13.70.0 -- cloudformation/`

> **Prior range (v12.47.2 → v13.26.0) is complete.** Those 13 items were implemented in
> `feat/cdk-upstream-changes` and audited 2026-06-30. See the git history of this file if you need
> that content; it has been removed here to keep this document focused on the current upgrade.

---

## Context: this document is part of the v13.70.0 upgrade

The application-code upgrade from v13.26.0 → v13.70.0 is happening **in parallel** with this work.
That matters because the largest change in this range (the stateless/stateful "hub" split, item 1) is
**not a pure infrastructure change** — it depends on application support for `CLOUDTAK_Server_Mode`
and the hub RPC listener. The CDK work and the app work must land together.

**Ordering constraint:** items 2–5 are independent and can be implemented and deployed at any time.
Item 1 must not be deployed until the v13.70.0 application image is the one being deployed.

---

## Audit Status

_Analysed against upstream `v13.26.0..v13.70.0` and the current CDK codebase on 2026-08-20._
_All five items implemented, then deploy-tested on the PDX (test) environment._

_**Re-verified 2026-08-21 against upstream's actual `cloudformation/` files** rather than this
summary, after a deployment-behaviour defect was found in the stateful service. Items 2, 3 and 4
matched exactly, including every alarm threshold. Item 1 had one real defect, now fixed. Item 5
(dashboard) is written in CDK idiom rather than ported, so it has not been compared
widget-by-widget; a discrepancy there costs a missing graph rather than availability. The
re-verification also found the events service carrying the same deployment defect. See "Read this
before implementing from this document" below._

| # | Change | Source | Priority | Breaking | CDK Status |
|---|--------|--------|----------|----------|------------|
| 1 | Stateless/stateful ("hub") service split | `lib/stateful.js` *(new)*, `lib/api.js` | High | **Yes** | ✅ Done |
| 2 | API service autoscaling + default 2 tasks | `lib/api.js` | High | No | ✅ Done |
| 3 | Events task memory 2048 → 4096 MB | `lib/events.js` | Medium | No | ✅ Done |
| 4 | Inlined ELB/RDS alarms (drop `batch-alarms`) | `lib/alarms.js`, `CloudTAK.template.js` | Medium | No | ✅ Done |
| 5 | CloudWatch dashboard | `lib/dashboard.js` *(new)* | Low | No | ✅ Done |

New CDK files: `cdk/lib/constructs/{hub-load-balancer,cloudtak-stateful,dashboard}.ts`.
Modified: `cdk/lib/constructs/{events-service,alarms,security-groups,cloudtak-api}.ts`,
`cdk/lib/cloudtak-stack.ts`, `cdk/lib/stack-config.ts`, `cdk/cdk.json`.

### Read this before implementing from this document

**This document is a summary. Implement against upstream's actual CloudFormation, not
against this file.** Where a property is described below it was checked; where this file
is *silent*, that silence means "not examined", not "upstream has no opinion".

That distinction caused a real defect. The stateful ECS service was implemented with
`minHealthyPercent: 0` / `maxHealthyPercent: 100` — draining the only task before starting
its replacement, so every deploy took browser WebSockets and hub RPC down. The reasoning
looked sound from first principles (`ConnectionPool` is per-process, so two `hub` tasks must
not coexist) and was written up confidently as a deliberate deviation. Upstream actually
specifies `MinimumHealthyPercent: 100` / `MaximumPercent: 200` with `DesiredCount: 1`: it
rolls forward and accepts a brief overlap. The invented rationale was wrong, and nothing in
this document contradicted it because the subject never came up.

The files are small and readable. Fetch them directly:

```
https://raw.githubusercontent.com/dfpc-coe/CloudTAK/v13.70.0/cloudformation/lib/api.js
https://raw.githubusercontent.com/dfpc-coe/CloudTAK/v13.70.0/cloudformation/lib/stateful.js
https://raw.githubusercontent.com/dfpc-coe/CloudTAK/v13.70.0/cloudformation/lib/events.js
https://raw.githubusercontent.com/dfpc-coe/CloudTAK/v13.70.0/cloudformation/lib/alarms.js
https://raw.githubusercontent.com/dfpc-coe/CloudTAK/v13.70.0/cloudformation/lib/dashboard.js
```

Note `vendor/upstream` carries only `api/` and `tasks/`, so upstream's CloudFormation is
**not** available locally — which is part of why the summary got used as the source.

### ECS deployment and restart configuration, as upstream actually declares it

Verified against the files above. Every service rolls forward; none drains first.

| Upstream service | DesiredCount | MinimumHealthyPercent | MaximumPercent | Container `RestartPolicy` |
|---|---|---|---|---|
| `Service` (stateless API) | `ApiDesiredCount` (2) | *(unset → ECS default 100)* | *(unset → 200)* | Enabled, `RestartAttemptPeriod: 300` |
| `StatefulService` | 1 | **100** (explicit) | **200** (explicit) | Enabled, `RestartAttemptPeriod: 300` |
| `EventsService` | 1 | *(unset → ECS default 100)* | *(unset → 200)* | Enabled, `RestartAttemptPeriod: 300` |

Two traps here for a CDK port:

- **CDK's default is not ECS's default.** `ecs.FargateService` defaults `minHealthyPercent`
  to 50. On a single-task service that rounds down to *zero* required healthy, i.e.
  drain-first. Upstream reaching the same 100 by simply omitting the property means a
  faithful port has to set it explicitly. This is exactly how the events service acquired
  the same bug silently — nothing in `events-service.ts` mentioned the property at all.
- The stateless API service used to use `minHealthyPercent: environment === 'prod' ? 100 : 50`.
  With two tasks that was reduced capacity rather than an outage, and prod already matched
  upstream, but it made dev-test a weaker rehearsal for prod than it should be. Now 100 in
  every environment.

All three services now also match upstream's container restart policy. As implemented:

| | DesiredCount | minHealthyPercent | maxHealthyPercent | `RestartPolicy` |
|---|---|---|---|---|
| `CloudTakApiService` | 2 | 100 | 200 | `Enabled: true`, `RestartAttemptPeriod: 300` |
| `CloudTakStatefulService` | 1 | 100 | 200 | `Enabled: true`, `RestartAttemptPeriod: 300` |
| `EventsService` | 1 | 100 | 200 | `Enabled: true`, `RestartAttemptPeriod: 300` |

Read off the synthesized `TAK-Demo-CloudTAK.template.json`, not from the source. The fork-local
`RetentionService` task definition deliberately has no restart policy: it has no ECS service, so
there is no long-running container to restart.

### Deliberate deviations from upstream

These are the places the CDK implementation does **not** match `cloudformation/` one-for-one.
Each is intentional; the reasoning is repeated at the point of use in the code.

| Where | Upstream | Here | Why |
|---|---|---|---|
| Alarms, item 4 | `FreeStorageSpace < 10 GiB` | `FreeLocalStorage < 1 GiB`, `notBreaching`, no insufficient-data action | `FreeStorageSpace` is not published for Aurora, which both projects run. As written the alarm would sit in `INSUFFICIENT_DATA` forever and — because upstream routes insufficient-data to high urgency — page continuously. **The 1 GiB threshold is a guess; validate it against observed values on demo.** |
| Alarms, item 4 | stateless service only | adds `StatefulCpu` / `StatefulMemory` | The stateful tier is a single task with no autoscaling and owns every TAK Server connection. Losing it is a full outage, so it needs its own signal. |
| Stateful service, item 1 | public subnets, `assignPublicIp: true` | `PRIVATE_WITH_EGRESS`, no public IP | The existing API service already reaches TAK Server from private subnets via NAT. No reason to regress that. |
| Stateful service, item 1 | `PORT: 5000` | no `PORT` override | Would break the container. `api/nginx.conf.js` has nginx listening on 5000 and proxying to node on 5001 (`api/index.ts` default). Forcing node onto 5000 collides with nginx. |
| Stateful service, item 1 | `command: ['npm','run','prod']` | image default `CMD ["./start"]` | `npm run prod` skips nginx entirely, so the WebSocket upgrade path on 5000 would never be served. |
| Stateful service, item 1 | inherits `CLOUDTAK_Hub_URL` | variable removed | This service *is* the hub; pointing it at itself is wrong. |
| Hub ALB, item 1 | — | listener `open: false` | CDK's default would add an `0.0.0.0/0` ingress rule. `SecurityGroups` already grants the stateless tier explicitly. |
| Dashboard, item 5 | `FreeStorageSpace` widget | `ServerlessDatabaseCapacity` + `FreeLocalStorage` | Same Aurora reasoning as the alarm. |
| Alarms, item 4 | DB alarms dimensioned on `DBInstanceIdentifier` | cluster-level `DBClusterIdentifier` | CDK's `DatabaseCluster.metricCPUUtilization()` emits the cluster dimension. On a single-writer Serverless v2 cluster these track together, and cluster-level survives a writer replacement. Difference rather than defect — recorded because it was previously undocumented. |


#### Consequence worth stating: the stateful tier runs nginx here, upstream's does not

The `PORT` and `command` rows above are two halves of one difference. Upstream's stateful task
sets `PORT: 5000` *and* `Command: ['npm','run','prod']`, so node binds 5000 directly and nginx
never starts. Here the image's default `./start` runs, so nginx owns 5000 and proxies to node
on 5001.

Both satisfy the ALB: the target group health-checks `/api` on 5000 either way, and
`api/nginx.conf.js` sets the `Upgrade` / `Connection` headers so the WebSocket path works
through the proxy. But it is an architectural difference in the request path, not just two
omitted properties, and the nginx config is now load-bearing for the stateful tier.

#### Container restart policy — adopted

Upstream enables an ECS **container**-level restart policy on all three containers, and this
fork now matches it. When the process exits, ECS restarts the container inside the existing task
instead of the task being stopped and replaced. `RestartAttemptPeriod: 300` means a container
must stay up 300 seconds before another restart is permitted, which is what stops a crash loop
from restarting forever. 300 is also the AWS default, so upstream is being explicit rather than
unusual.

In CDK this is `enableRestartPolicy: true` plus
`restartAttemptPeriod: cdk.Duration.seconds(300)` on the container definition options
(`aws-cdk-lib` 2.266.0; it also offers `restartIgnoredExitCodes`, unused here).

It matters most on the stateful tier, where replacing the task means Fargate placement, an
image pull, a new ENI, re-registration with two target groups, and re-establishing every TAK
Server connection. An in-place restart still loses the connections, since it is a new process,
but skips everything else.

One trade-off was accepted knowingly. A container that starts, crashes and restarts in place
keeps its task `RUNNING`, so it does not count as a failed task for the deployment circuit
breaker. The ALB health check remains the backstop — an unhealthy target *does* count — so a
genuinely broken deploy still rolls back, just via health checks rather than task failures,
which is slightly slower. In exchange, steady-state crash behaviour is no worse: without the
policy ECS replaces the task indefinitely, with it ECS restarts the container indefinitely.
Neither self-heals, so this introduces no new failure mode.

### Status key

- ✅ **Done** — implemented in the CDK codebase
- ⚠️ **Partial** — some of it exists; gaps noted in the section
- ❌ **Not started** — no equivalent in CDK
- ⬜ **Out of scope** — resource owned by another stack (e.g. base-infra)

### Summary of the diff

```
cloudformation/CloudTAK.template.js |  25 ++-------
cloudformation/lib/alarms.js        | 161 +++++++++++++++++++++++++++
cloudformation/lib/api.js           |  49 +++++++++-
cloudformation/lib/dashboard.js     | 260 ++++++++++++++++++++++++++++++++++++++
cloudformation/lib/events.js        |   2 +-
cloudformation/lib/stateful.js      | 261 +++++++++++++++++++++++++++++++++++++++
6 files changed, 735 insertions(+), 23 deletions(-)
```

---

## 1. Stateless/stateful ("hub") service split

> **CDK Status: ❌ Not started**
>
> The current CDK stack runs a single `ecs.FargateService` (`cloudtak-api.ts`, `this.service`) that
> serves the web app, the REST API, the browser WebSockets, *and* holds the pooled TLS connections to
> TAK Server. `cdk.json` pins `ecs.desiredCount: 1` in both `dev-test` and `prod`, which is not
> incidental — `ConnectionPool` is per-process in-memory state, so scaling that service today would
> duplicate every TAK Server session and break `POST /layer/:id/cot` routing. This change is upstream's
> fix for exactly that problem.

**Source file:** `cloudformation/lib/stateful.js` (new), plus `cloudformation/lib/api.js`
**Priority:** High (architecture — unblocks horizontal scaling of the web/API tier)
**Breaking:** ⚠️ YES — new services, new ALB, new listener rule, and container env changes on the existing service

### What changed

Upstream split the single monolithic service into two ECS services running **the same image** with
different roles selected by a `CLOUDTAK_Server_Mode` env var:

| | Stateless (`Service`, existing) | Stateful (`StatefulService`, new) |
|---|---|---|
| `CLOUDTAK_Server_Mode` | `api` | `hub` |
| Desired count | `ApiDesiredCount` (default **2**), autoscales to 10 | **1** (fixed) |
| Ports | 5000 | 5000 (HTTP/WS) + 5002 (hub RPC) |
| Serves | web app, REST API | browser WebSockets, TAK Server connection pool |
| Reached via | public ALB default action | public ALB listener rule (WebSocket only) + internal hub ALB |

New resources in `stateful.js`:

- `StatefulLogs` — CloudWatch log group `${StackName}-stateful`, 7-day retention
- `StatefulTaskDefinition` — Fargate task, `ComputeCpu`/`ComputeMemory` (same sizing as the API task),
  container `api` with ports 5000 + 5002, `RestartPolicy` enabled (300s attempt period),
  `DependsOn: ['SigningSecret', 'GeofenceSecret']`
- `StatefulService` — `DesiredCount: 1`, deployment circuit breaker with rollback, registered against
  **two** target groups (5000 and 5002)
- `StatefulTargetGroup` — port 5000, health check `/api`, matcher `200,202,302,304`,
  `deregistration_delay.timeout_seconds: 0`
- `StatefulListenerRule` — on the **public** HTTPS listener at **priority 10**, matching
  `Upgrade: websocket` header **AND** path `/api`; forwards to `StatefulTargetGroup`
- `HubELB` — new **internal** ALB in the private subnets, named `${StackName}-hub`
- `HubListener` — port 80 HTTP → `HubRpcTargetGroup`
- `HubRpcTargetGroup` — port 5002, health check `/hub`, matcher `200`, dereg delay 30s
- `HubELBSecurityGroup` — ingress tcp/80 from `ServiceSecurityGroup` (stateless tasks only)
- `StatefulServiceSecurityGroup` — ingress tcp/5000 from `ELBSecurityGroup`, tcp/5002 from
  `HubELBSecurityGroup`

Changes to the existing stateless service in `api.js`:

```diff
+ { Name: 'CLOUDTAK_Server_Mode', Value: 'api' },
+ { Name: 'CLOUDTAK_Hub_URL', Value: cf.join(['http://', cf.getAtt('HubELB', 'DNSName')]) },
```

### Why this matters for us

This is upstream independently solving the coupling problem described in
`ETL-ARCHITECTURE-PROPOSAL.md`. Adopting upstream's split is strongly preferable to building our own
equivalent — it keeps us aligned for future syncs.

Note the change is not infrastructure-only: upstream also restructured `api/` into `api/common/`,
`api/stateful/`, and `api/stateless/`, with `api/common/hub/index.ts` defining a `HubClient` RPC
contract (`submitCots`, `wsNotify`, `wsPresence`, `connectionSync`, …) implemented twice —
`stateful/lib/hub/local.ts` in-process and `stateless/lib/hub/remote.ts` over the internal hub ALB
provisioned here. `api/lib/` and `api/routes/` no longer exist, which affects every fork patch that
references those paths — tracked on the application side, not here.

### How to implement in CDK

**Step 0 — gate on app support.** Confirm the deployed image is v13.70.0 and honours
`CLOUDTAK_Server_Mode` / `HUB_RPC_PORT`. Deploying this against a v13.26.0 image will produce a
stateful service that never passes its `/hub` health check.

**Step 1** — Expose the stateless service's security group and the ALB security group so the new
constructs can reference them. `security-groups.ts` already exposes `ecs` (≡ `ServiceSecurityGroup`)
and `alb` (≡ `ELBSecurityGroup`), so add two new SGs there:

```typescript
// hub internal ALB SG
this.hubAlb = new ec2.SecurityGroup(this, 'HubELBSecurityGroup', {
    vpc, description: 'Internal hub RPC access from the stateless API service',
    securityGroupName: `TAK-${stackName}-CloudTAK-hub-elb-sg`,
});
this.hubAlb.addIngressRule(this.ecs, ec2.Port.tcp(80), 'Hub RPC from stateless API tasks');

// stateful service SG
this.stateful = new ec2.SecurityGroup(this, 'StatefulServiceSecurityGroup', {
    vpc, description: 'WebSocket traffic from the ELB and hub RPC from the internal ALB',
    securityGroupName: `TAK-${stackName}-CloudTAK-stateful-sg`,
});
this.stateful.addIngressRule(this.alb, ec2.Port.tcp(5000), 'ELB WebSocket Traffic');
this.stateful.addIngressRule(this.hubAlb, ec2.Port.tcp(5002), 'Hub RPC from internal ALB');
```

**Step 2** — Create the internal hub ALB + target group. Suggest a new construct
`cdk/lib/constructs/hub-load-balancer.ts` mirroring the existing `load-balancer.ts` style:

```typescript
this.alb = new elbv2.ApplicationLoadBalancer(this, 'HubELB', {
    vpc,
    internetFacing: false,
    loadBalancerName: `TAK-${stackName}-CloudTAK-hub`,
    securityGroup: hubAlbSecurityGroup,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});

this.rpcTargetGroup = new elbv2.ApplicationTargetGroup(this, 'HubRpcTargetGroup', {
    vpc, port: 5002, protocol: elbv2.ApplicationProtocol.HTTP,
    targetType: elbv2.TargetType.IP,
    deregistrationDelay: cdk.Duration.seconds(30),
    healthCheck: {
        enabled: true, path: '/hub',
        interval: cdk.Duration.seconds(15), timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2, unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
    },
});

this.alb.addListener('HubListener', {
    port: 80, protocol: elbv2.ApplicationProtocol.HTTP,
    defaultTargetGroups: [this.rpcTargetGroup],
});
```

**Step 3** — Create the stateful service. Suggest `cdk/lib/constructs/cloudtak-stateful.ts`, reusing
the *same* container image, exec role, and task role as `cloudtak-api.ts` (do not duplicate the IAM
roles — pass them in). Key details:

```typescript
const taskDef = new ecs.FargateTaskDefinition(this, 'StatefulTaskDefinition', {
    cpu: envConfig.ecs.taskCpu,
    memoryLimitMiB: envConfig.ecs.taskMemory,
    executionRole, taskRole,
});

const container = taskDef.addContainer('api', {
    image: containerImage,          // same image as the API service
    command: ['npm', 'run', 'prod'],
    environment: {
        ...sharedApiEnvironment,     // reuse the API env map
        'CLOUDTAK_Server_Mode': 'hub',
        'PORT': '5000',
        'HUB_RPC_PORT': '5002',
        // NOTE: no CLOUDTAK_Hub_URL — this service *is* the hub
    },
    secrets: sharedApiSecrets,
    logging: ecs.LogDrivers.awsLogs({ logGroup: statefulLogGroup, streamPrefix: stackName }),
});
container.addPortMappings({ containerPort: 5000 }, { containerPort: 5002 });

this.service = new ecs.FargateService(this, 'StatefulService', {
    serviceName: `TAK-${stackName}-CloudTAK-stateful`,
    cluster, taskDefinition: taskDef,
    desiredCount: 1,                                   // must stay 1
    securityGroups: [statefulSecurityGroup],
    assignPublicIp: true,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    healthCheckGracePeriod: cdk.Duration.seconds(300),
    circuitBreaker: { rollback: true },
    propagateTags: ecs.PropagatedTagSource.SERVICE,
    enableExecuteCommand: envConfig.ecs.enableEcsExec,
});

// register against BOTH target groups
this.service.attachToApplicationTargetGroup(statefulTargetGroup);   // 5000
this.service.attachToApplicationTargetGroup(hubRpcTargetGroup);     // 5002
```

For the second attachment CDK needs an explicit container/port, so use
`loadBalancerTarget({ containerName: 'api', containerPort: 5002 })` with
`hubRpcTargetGroup.addTarget(...)` rather than `attachToApplicationTargetGroup` for the RPC group.

**Step 4** — Add the WebSocket listener rule on the public HTTPS listener. Priority 10 is free in our
stack — the only ALB listener rule priority in use is 1, by `BlockScanner` in `load-balancer.ts`:

```typescript
loadBalancer.httpsListener.addAction('StatefulWebSocket', {
    priority: 10,
    conditions: [
        elbv2.ListenerCondition.httpHeader('Upgrade', ['websocket']),
        elbv2.ListenerCondition.pathPatterns(['/api']),
    ],
    action: elbv2.ListenerAction.forward([statefulTargetGroup]),
});
```

**Step 5** — Add the two new env vars to the existing stateless API container in `cloudtak-api.ts`:

```typescript
'CLOUDTAK_Server_Mode': 'api',
'CLOUDTAK_Hub_URL': `http://${hubLoadBalancer.loadBalancerDnsName}`,
```

**Deployment notes:**
- The stateful service must be healthy before the stateless service is useful (the stateless tier
  depends on the hub for anything requiring a TAK Server connection). Deploy in one changeset and let
  CloudFormation order it via the target-group/listener dependencies.
- Upstream puts the stateful service in **public** subnets with `assignPublicIp: true` (it needs
  outbound access to TAK Server) while the hub ALB is **internal** in private subnets. Keep that
  split; do not move the stateful tasks into private subnets without confirming NAT egress.
- WebSocket sessions will drop during the cutover as browser connections migrate to the new target
  group. Expect a reconnect storm; the client-side reconnect logic (patch 048/070 lineage) should
  absorb it, but schedule accordingly.

---

## 2. API service autoscaling + default 2 tasks

> **CDK Status: ❌ Not started**
>
> `cloudtak-api.ts:492` sets `desiredCount: envConfig.ecs.desiredCount` and there is no autoscaling
> on the API service at all (`autoScaleTaskCount` is only used in `events-service.ts`). `cdk.json`
> sets `ecs.desiredCount: 1` for both environments.

**Source file:** `cloudformation/lib/api.js`
**Priority:** High (only meaningful *after* item 1 — see warning)
**Breaking:** No

### What changed

Two new parameters and two new resources:

```javascript
ApiDesiredCount:          { Type: 'Number', Default: 2, MinValue: 0, MaxValue: 10 }
ApiTargetCPUUtilization:  { Type: 'Number', Default: 70 }
```

- `Service.DesiredCount` changed from hardcoded `1` → `cf.ref('ApiDesiredCount')` (default 2)
- `ApiScalableTarget` — `ecs:service:DesiredCount`, min = `ApiDesiredCount`, max 10.
  Note it **reuses `EventsAutoScalingRole`** (defined in `events.js`) rather than creating its own.
- `ApiCPUScalingPolicy` — target-tracking on `ECSServiceAverageCPUUtilization`,
  target `ApiTargetCPUUtilization` (70), scale-in cooldown 300s, scale-out 60s

There is deliberately **no memory scaling policy** on the API service (unlike the Events service,
which has both).

### ⚠️ Hard dependency on item 1

Do **not** raise `desiredCount` above 1 until the hub split is deployed. Scaling the current
monolithic service duplicates TAK Server connections per task and breaks layer CoT delivery, which is
precisely why `cdk.json` pins it to 1 today. Item 2 is only safe once the stateless tier no longer
owns `ConnectionPool`.

### How to implement in CDK

**Step 1** — Add config knobs to `cdk.json` (`ecs` block) and `stack-config.ts`:

```jsonc
"ecs": {
  "taskCpu": 2048,
  "taskMemory": 4096,
  "desiredCount": 2,              // dev-test; was 1
  "targetCpuUtilization": 70,     // new
  "maxCapacity": 10               // new
}
```

**Step 2** — Add autoscaling in `cloudtak-api.ts` after the service is created. CDK creates the
scalable target and its IAM role automatically, so there's no need to share `EventsAutoScalingRole`
the way the CloudFormation template does:

```typescript
const scaling = this.service.autoScaleTaskCount({
    minCapacity: envConfig.ecs.desiredCount,
    maxCapacity: envConfig.ecs.maxCapacity ?? 10,
});

scaling.scaleOnCpuUtilization('ApiCPUScaling', {
    targetUtilizationPercent: envConfig.ecs.targetCpuUtilization ?? 70,
    scaleInCooldown: cdk.Duration.seconds(300),
    scaleOutCooldown: cdk.Duration.seconds(60),
});
```

Match upstream and do **not** add a memory scaling policy here.

---

## 3. Events task memory 2048 → 4096 MB

> **CDK Status: ❌ Not started**
>
> `events-service.ts:119-120` has `cpu: 1024, memoryLimitMiB: 2048`. CPU is already correct; only
> memory needs to change. (Autoscaling on the Events service is already implemented — lines 187-202.)

**Source file:** `cloudformation/lib/events.js`
**Priority:** Medium (operational — OOM headroom for bulk imports)
**Breaking:** No

### What changed

```diff
  Cpu: 1024,
- Memory: 2048,
+ Memory: 4096,
```

### How to implement in CDK

One line in `cdk/lib/constructs/events-service.ts`:

```typescript
const taskDefinition = new ecs.FargateTaskDefinition(this, 'EventsTaskDefinition', {
    cpu: 1024,
    memoryLimitMiB: 4096,   // ← was 2048
    // …
});
```

1024 CPU / 4096 MB is a valid Fargate combination (1 vCPU supports 2–8 GB).

---

## 4. Inlined ELB/RDS alarms (drop `@openaddresses/batch-alarms`)

> **CDK Status: ⚠️ Partial**
>
> `cdk/lib/constructs/alarms.ts` creates `highUrgencyTopic` and `lowUrgencyTopic` and exactly **one**
> alarm (`EventsServiceAlarm`). None of the eight ELB/RDS alarms below exist. Because our CDK never
> used `@openaddresses/batch-alarms`, the alarms that package used to contribute upstream were simply
> never present on our side — so this is a genuine monitoring gap, not just a refactor to mirror.

**Source file:** `cloudformation/lib/alarms.js`, `cloudformation/CloudTAK.template.js`
**Priority:** Medium (observability)
**Breaking:** No

### What changed

Upstream dropped the `@openaddresses/batch-alarms` dependency and hand-wrote the alarms it had been
generating. `CloudTAK.template.js` lost its `ELBAlarms(...)` / `RDSAlarms(...)` merge calls, and
`alarms.js` gained eight alarms — all wired to `HighUrgencyAlarmTopic` for both `AlarmActions` and
`InsufficientDataActions`:

| Alarm | Metric | Threshold |
|---|---|---|
| `BatchELBCpuAlarm` | `AWS/ECS` `CPUUtilization` (Service) | > 80%, 10 × 60s, Average |
| `BatchELBMemoryAlarm` | `AWS/ECS` `MemoryUtilization` (Service) | > 80%, 10 × 60s, Average |
| `BatchELBAlarmHTTPCodeELB5XX` | `HTTPCode_ELB_5XX_Count` | > 1, 2 × 60s, Sum |
| `BatchELBAlarmHTTPCodeBackend5XX` | `HTTPCode_Target_5XX_Count` | > 1, 2 × 60s, Sum |
| `BatchELBAlarmHTTPCodeBackend5XXDuration` | `HTTPCode_Target_5XX_Count` | > 5, 4 × 300s, Sum |
| `BatchELBAlarmP99Latency` | `TargetResponseTime` | > 10s, 5 × 60s, p99 |
| `BatchDBCpuAlarm` | `AWS/RDS` `CPUUtilization` | > 80%, 10 × 60s, Average |
| `BatchDBFreeStorage` | `AWS/RDS` `FreeStorageSpace` | < 10 GiB (10737418240), 10 × 60s |

The four HTTP-code/latency alarms use `TreatMissingData: notBreaching` (except P99, which does not
set it).

### How to implement in CDK

Extend `cdk/lib/constructs/alarms.ts`. It will need new props: the ALB, the target group, the ECS
service, and the RDS instance. Example for two of them:

```typescript
new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
    alarmName: `TAK-${stackName}-CloudTAK-CPUUtilization-${cdk.Stack.of(this).region}`,
    metric: props.service.metricCpuUtilization({ period: cdk.Duration.seconds(60), statistic: 'Average' }),
    threshold: 80,
    evaluationPeriods: 10,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
}).addAlarmAction(new cwActions.SnsAction(this.highUrgencyTopic));

new cloudwatch.Alarm(this, 'DbFreeStorageAlarm', {
    alarmName: `TAK-${stackName}-CloudTAK-DBFreeStorage-${cdk.Stack.of(this).region}`,
    metric: props.dbInstance.metricFreeStorageSpace({ period: cdk.Duration.seconds(60) }),
    threshold: 10 * 1024 * 1024 * 1024,
    evaluationPeriods: 10,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
}).addAlarmAction(new cwActions.SnsAction(this.highUrgencyTopic));
```

Remember to also set the "insufficient data" action to match upstream:

```typescript
alarm.addInsufficientDataAction(new cwActions.SnsAction(this.highUrgencyTopic));
```

**Decision needed:** once item 1 lands there are *two* ECS services worth alarming on. Upstream's
alarms target only the stateless `Service`. Consider duplicating the CPU/memory alarms for
`StatefulService` — arguably more important, since it is a single-task service with no autoscaling
and holds all TAK Server connections.

---

## 5. CloudWatch dashboard

> **CDK Status: ❌ Not started**
>
> No dashboard construct exists in `cdk/lib/constructs/`.

**Source file:** `cloudformation/lib/dashboard.js` (new)
**Priority:** Low (observability convenience; no functional impact)
**Breaking:** No

### What changed

New `AWS::CloudWatch::Dashboard` resources, hub-aware from the outset. The main dashboard
(`${StackName}-${Region}-batchelb`) has widgets for:

1. **HTTP status** — 2xx/4xx/5xx (target + ELB) on the public ALB
2. **Hub HTTP status (internal ELB)** — same metrics against `HubELB`
3. **Latency** — `TargetResponseTime` avg/percentiles on the public ALB
4. **Service capacity** — stateless healthy hosts (`HealthyHostCount` on the public target group),
   stateful desired/healthy counts (`HubTargetGroupFullName` + ECS `DesiredCapacity`)
5. **CPU / Memory** — both stateless and stateful services side by side
6. **5XX Requests**
7. **Recent Errors** — log-query widget

Plus a separate RDS widget set including `FreeStorageSpace`. The dashboard uses CFN `Sub` variables
for `LoadBalancerFullName`, `HubLoadBalancerFullName`, `TargetGroupFullName`,
`HubTargetGroupFullName`, `StatefulServiceName`, and `Cluster`.

Note the source comment: the red threshold line at 80% is intended to match the CPU/memory alarm
thresholds in item 4 — keep the two in sync if we change either.

### How to implement in CDK

Add `cdk/lib/constructs/dashboard.ts` using `cloudwatch.Dashboard` with `GraphWidget`s, taking the
ALB/target-group/service/DB references as props. CDK's L2 constructs generate the widget JSON, so
this is a rewrite in CDK idiom rather than a JSON port:

```typescript
const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
    dashboardName: `TAK-${stackName}-CloudTAK-${cdk.Stack.of(this).region}`,
});

dashboard.addWidgets(new cloudwatch.GraphWidget({
    title: 'CPU / Memory',
    width: 24,
    left: [
        props.service.metricCpuUtilization({ label: 'stateless cpu' }),
        props.statefulService.metricCpuUtilization({ label: 'stateful cpu' }),
    ],
}));
```

Recommend deferring this until items 1–4 are done, since half the widgets reference hub resources
that don't exist yet. Low value relative to effort; skip entirely if dashboards aren't part of the
TAK.NZ observability approach.

---

## Recommended implementation order

1. **Item 3** (Events memory) — one line, independent, deploy any time.
2. **Item 4** (alarms) — independent, closes a real monitoring gap that exists today.
3. **Item 1** (hub split) — the big one; must land with the v13.70.0 application image.
4. **Item 2** (API autoscaling) — immediately after item 1, never before.
5. **Item 5** (dashboard) — optional, last, once the hub resources exist to reference.

## Cross-references

- `ETL-ARCHITECTURE-PROPOSAL.md` — that document's "TAK Gateway" item has been re-scoped (2026-08-20)
  to *adopt* upstream's stateless/hub split rather than design a bespoke equivalent, and now depends on
  item 1 here for its infrastructure. Items 2–4 there (streaming inputs, GeoChat agents, KMZ output)
  are unaffected by upstream and remain fork-local work.
- `docs/fork/FORK-DELTA.md` — application-side patches for the v13.70.0 sync are tracked
  separately there; this document covers infrastructure only.
