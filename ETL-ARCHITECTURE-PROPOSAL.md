# CloudTAK ETL Architecture Proposal

## Status

Draft for discussion. No code changes have been made.

**Revised 2026-08-20** after analysing upstream v13.70.0. Upstream has independently implemented the
service split this proposal originally called for (the "TAK Gateway"), so that item has been re-scoped
from *design and build* to *adopt via the in-flight v13.70.0 sync*. The remaining three requirements
are unaffected by upstream and still need to be built in our fork.

This document proposes changes to a local TAK.NZ fork; upstream alignment is not expected for the
new capabilities (agents, KMZ, streaming inputs).

## Problem statement

CloudTAK's built-in ETL system (Connection → Layer → Task, backed by one AWS Lambda per Layer) works
well for the case it was designed for: periodically polling or receiving a webhook from an external
API and converting the result into CoT delivered to TAK Server. We have four requirements it does not
meet:

1. **Streaming ingestion.** Some sources push live data over a persistent WebSocket or gRPC stream
   rather than exposing a poll-able API or calling a webhook. Lambda (15-minute max, cold-started per
   invocation) cannot hold a persistent inbound connection, so these sources cannot be ingested today
   without an always-on component.
2. **Bedrock-based AI agents over GeoChat.** Multiple AI agents that receive GeoChat messages
   addressed to them and send replies, as first-class TAK identities. The ETL model has no
   event-driven trigger (only cron/webhook) and no concept of a Layer having its own TAK identity.
3. **KMZ network-link output.** Expose some external data to TAK clients as a network-streaming KMZ
   (client-polled via `<NetworkLink><refreshInterval>`) rather than pushed as CoT. The Layer model
   only knows how to produce CoT.
4. **Tight coupling between ETL delivery and the web map process.** `ConnectionPool` — the in-memory
   registry of live, cert-authenticated TLS sockets to TAK Server — lives in the same single ECS task
   that serves the Vue web app and browser WebSockets. This makes the web/API tier impossible to scale
   and forces every new delivery mechanism through one monolith.

**Requirement 4 is now solved upstream** (see below). Requirements 1–3 remain ours to build, and the
upstream work makes 2 and 3 cleaner to implement than originally scoped.

## Architecture: today vs. after the v13.70.0 sync

### Today (what we run: v13.26.0)

- **Connection**: a persistent TLS/mTLS identity to TAK Server, cert/key in the `connections` table.
  `ConnectionPool` (`api/lib/connection-pool.ts`) is a singleton in-memory `Map`, one live
  `TAK.connect()` socket per enabled Connection plus one per logged-in browser Profile.
- **Layer**: a child of a Connection representing one ETL job (cron schedule, webhook flag, filters,
  per-layer environment/secrets).
- **Task**: a versioned container image in a shared ECR repo, referenced by `layer.task`.
- **Execution**: `api/lib/aws/lambda.ts` generates a per-Layer CloudFormation stack — one Lambda,
  triggered by EventBridge cron and/or an API Gateway webhook route, plus a per-layer SQS FIFO queue
  feeding the same Lambda for outgoing.
- **CoT delivery**: the Lambda calls `this.submit(fc)` (`@tak-ps/etl`) → `POST /layer/:id/cot` →
  handler resolves the Connection's socket from `ConnectionPool` via in-memory `Map.get()` → writes CoT.
- **Process topology**: one `Config` object owning `conns: ConnectionPool`, `wsClients`, and the
  Express/WebSocket server, in a single process; one Fargate service pinned to `desiredCount: 1`.
  Not incidental — `ConnectionPool` is per-process memory with no broker, so scaling would duplicate
  every TAK Server session and randomly break layer delivery depending on which task a request hit.

### After the v13.70.0 sync (in flight, parallel workstream)

Upstream split `api/` into three trees and introduced a stateless/stateful ("hub") service split:

| Tree | Contents |
|---|---|
| `api/common/` | models, auth, config, `connection-config.ts`, **`hub/index.ts`** |
| `api/stateful/` | `connection-pool.ts`, `connection-web.ts`, `sinks.ts`, `connection-geofence.ts`, `events-pool.ts`, `hub/local.ts`, `routes/cots.ts`, `routes/ws.ts` |
| `api/stateless/` | REST routes, ETL/Lambda machinery, `hub/remote.ts` |

The same container image runs in two modes selected by `CLOUDTAK_Server_Mode`:

| | Stateless (`api`) | Stateful (`hub`) |
|---|---|---|
| Desired count | 2, autoscales to 10 | 1 (fixed) |
| Ports | 5000 | 5000 (HTTP/WS) + 5002 (hub RPC) |
| Owns | web app, REST API | browser WebSockets, TAK Server connection pool |

`api/common/hub/index.ts` defines the internal contract:

```typescript
export interface HubClient {
    connectionSync(id, opts?): Promise<ConnStatus>;
    connectionStatus(ids): Promise<Record<string, ConnStatus>>;
    connectionSummary(): Promise<PoolSummary>;
    serverRefresh(opts?): Promise<ConnStatus>;
    submitCots(req: SubmitCotsRequest): Promise<void>;
    wsNotify(key, payload, excludeSession?): Promise<void>;
    wsPresence(keys): Promise<PresenceMap>;
    eventSet(layerid, cron): Promise<void>;
    coreEventSubmit(event): Promise<void>;
    geofenceRefresh(): Promise<void>;
    geofenceStatus(): Promise<GeofenceStatus>;
}
```

Two implementations: `stateful/lib/hub/local.ts` (in-process) and `stateless/lib/hub/remote.ts`
(HTTP RPC over an internal hub ALB). ETL delivery is already rewritten to use it —
`stateless/routes/connection-layer-cot.ts` now calls
`config.hub.submitCots({ connection, cots, broadcast: true })` instead of touching `ConnectionPool`.

Infrastructure side of this change is tracked separately in
**`docs/fork/README-CDK-V13-HUB-SPLIT.md` item 1**.

## Options considered

**Node-RED (or similar flow engine) as a general ETL replacement.** Good fit for arbitrary streaming
ingestion (native MQTT/WebSocket), but no TAK/CoT/GeoChat semantics, no Bedrock orchestration, and it
doesn't address coupling — a flow would still call into CloudTAK's API to deliver anything, so it
replaces one input adapter, not the system. Remains a reasonable option for streaming ingestion
specifically (see item 2 below), not for the system as a whole.

**Build a standalone ETL system from scratch.** Rejected. Would mean re-deriving TLS/cert-based TAK
identity, CoT parsing/construction, GeoChat dest-addressing, and mission-layer diffing — all of which
the existing `ConnectionPool` / `@tak-ps/node-cot` / `@tak-ps/node-tak` stack already does correctly.

**Build our own Gateway extraction (the original recommendation here).** **Now obsolete** — upstream
shipped an equivalent in v13.70.0. Building a bespoke version would create a permanent, large
divergence in the highest-traffic part of the codebase for no benefit.

**Fork and extend on top of upstream's hub split.** Recommended. Take upstream's stateless/stateful
architecture as the foundation, then generalize the Layer model for additional trigger types
(streaming) and output kinds (KMZ, chat) on top of it.

## Proposed architecture

### 1. Adopt upstream's stateless/hub split (was: build a TAK Gateway)

**Status: superseded by upstream. No bespoke design work needed.**

Requirement 4 is satisfied by completing the v13.70.0 sync. The pieces this proposal originally
specified map almost exactly onto what upstream shipped:

| Originally proposed | Upstream v13.70.0 equivalent |
|---|---|
| Extract `ConnectionPool`/`Sinks` into their own service | `api/stateful/` + `StatefulService` (ECS) |
| Internal outbound API (`POST /internal/connections/:id/cot`) | `HubClient.submitCots()` over the hub ALB |
| Inbound publish for browser fan-out | `HubClient.wsNotify()` / `wsPresence()`, `stateful/routes/cots.ts` |
| Replace in-memory `config.conns.get()` in layer delivery | already done in `stateless/routes/connection-layer-cot.ts` |

**Action for us:** none — the v13.70.0 sync and the CDK work in
`docs/fork/README-CDK-V13-HUB-SPLIT.md` item 1 (new stateful service, internal hub ALB, WebSocket
listener rule, `CLOUDTAK_Server_Mode` / `CLOUDTAK_Hub_URL` env vars) are both complete and deployed.

**One difference from the original proposal:** upstream's hub is a plain HTTP RPC over an internal
ALB rather than an SQS/EventBridge publish for the inbound direction. For the agent trigger (item 3)
that means we still need to add a queue-based fan-out ourselves rather than subscribing to something
that already exists.

### 2. Generalize Layer inputs: keep REST poll/webhook, add WebSocket and gRPC

**Status: unchanged by upstream. Filed upstream as
[#1678](https://github.com/dfpc-coe/CloudTAK/issues/1678); ours to build unless upstream picks it up.**

Confirmed against v13.70.0: the invocation types are still `Manual | Schedule | Webhook`. No
streaming support was added.

**Kept unchanged:**
- **Schedule** (poll): EventBridge cron → Lambda → `control()`. Right model for rate-limited APIs and
  periodic file drops.
- **Webhook** (push, request/response): API Gateway → Lambda. Right model for sources that can call
  out to us but don't need a persistent connection.

**Added — persistent stream inputs.** Neither WebSocket nor gRPC clients can live in a Lambda. Both
need a small number of long-running workers (ECS Fargate) that hold the connection, normalize
messages, and call the *same* `submit()` / `submitKMZ()` / `sendChat()` entry points. From the
Task's perspective a streaming input is just another `flow: Incoming` implementation; only the
invocation model differs.

- Extend `InvocationType` with `WebSocket` and `Grpc`.
- A Layer declaring one of these gets a small dedicated Fargate service instead of an EventBridge
  rule or API Gateway route — deployed per-layer via a sibling of the existing `Lambda.generate()`
  that emits an ECS service/task definition. Preserves per-layer isolation and CloudWatch alarms.
- Same Task image family, with two new long-running lifecycle methods a Task can implement:
  `connectWebSocket()` and `connectGrpc()`, each running indefinitely with internal
  reconnect-and-backoff, calling `submit()` as data arrives.
- Extend `capabilities()` so a Task can declare `WebSocket`/`Grpc`, and have the Layer config UI show
  connection-string / subscription-topic / proto-definition fields instead of a cron expression.
- **Cost/ops tradeoff:** this is where the Lambda scale-to-zero property is deliberately given up in
  exchange for the capability existing at all. Each streaming Layer becomes a small always-on Fargate
  task — a similar profile to the stateful hub service. Proportionate, but size and monitor per
  streaming Layer rather than assuming it's free.

### 3. GeoChat AI agents

**Status: simplified by upstream's hub, but the substance is still ours to build.**

Confirmed against v13.70.0: no agent identity concept, no event-driven inbound chat trigger, and no
Bedrock/AI code at all upstream. What *did* improve is the send path.

- **Identity**: each agent gets its own `Connection` — own cert, own TAK UID/callsign — provisioned
  through the existing Connection cert-lifecycle machinery (including our Authentik-based enrollment).
  Deliberate: Layers have no identity of their own, and an agent must be individually addressable in
  GeoChat, so the agent is modeled as a Connection, not a Layer under someone else's Connection.
- **Sending — now rides the existing hub contract.** `HubClient.submitCots()` already accepts
  `CoT[]`, and upstream ships `api/test/hub-cot-roundtrip.test.ts` asserting a `DirectChat` survives
  XML round-trip through the hub. So this collapses from "add a bespoke Gateway chat API" to
  "construct a `DirectChat` (from `@tak-ps/node-cot`) and pass it to `hub.submitCots()`". Add a
  `sendChat()` convenience method to `@tak-ps/etl` wrapping that call.
- **Receiving — event-driven trigger, still to build.** Add a producer in `api/stateful/` (alongside
  `sinks.ts`, which already filters CoT for outgoing SQS delivery) that recognizes chat CoT addressed
  to an agent-flagged Connection and drops it on that agent's per-layer SQS queue. Reuses the existing
  SQS → Lambda `EventSourceMapping` pattern from `LayerOutgoing`, with a chat-shaped message instead
  of a CoT-shaped one. This is a new *producer* on an existing *mechanism*.
- **Conversation state**: Postgres — extend `ProfileChat` (now `api/common/models/ProfileChat.ts`) or
  add a parallel agent-conversation table keyed by chatroom + agent Connection id. Keeps agent Lambda
  invocations stateless per message: read context, call Bedrock, `sendChat()` the reply, persist.
- **Addressing caveat:** GeoChat dest-addressing has a documented subtlety — UID-based
  `<marti><dest uid="..."/>` is authoritative for TAK Server routing; callsign dest is added only for
  plugins that substring-match `xmlDetail` (see the comment in `api/stateful/lib/connection-web.ts`).
  `sendChat()` must replicate this exactly.

In `@tak-ps/etl` terms: `control()` triggered by inbound chat instead of cron, and `sendChat()`
alongside `submit()` for the reply.

### 4. KMZ network-link output

**Status: unchanged by upstream (no KMZ support anywhere in v13.70.0 source). Lowest-risk item.**

Still the most independent piece and a good first slice to validate the "generalize Layer output
beyond CoT" pattern.

- Add an output-kind discriminator to Layer config: `cot` (default, unchanged) vs `kmz`.
- Input side unchanged for `kmz` layers — same Schedule/Webhook (or later WebSocket/Grpc) worker
  fetching the external data. Only the output changes.
- Add `submitKMZ(buffer)` to `@tak-ps/etl`, writing to the existing asset S3 bucket at a stable
  per-layer key instead of POSTing GeoJSON to `/layer/:id/cot`.
- Serve at a stable, token-scoped URL (`GET /layer/:id/kmz`, or straight from S3/CloudFront). TAK
  clients add it once as a Network Link; the KMZ's own `<NetworkLink><refreshInterval>` drives
  refresh. No push, no hub involvement, no TAK Server write on this path at all.

## Recommended sequencing

1. **v13.70.0 sync** — complete. Delivered requirement 4 and the hub contract that items 2–3 build
   against, including `docs/fork/README-CDK-V13-HUB-SPLIT.md` item 1.
2. **KMZ output** — smallest surface area, independent of everything else, proves the
   "Layer output ≠ CoT" pattern. Can start before the sync lands, but the file paths it touches move,
   so implementing after the sync avoids rework.
3. **GeoChat AI agents** — now cheaper than originally scoped, since sending rides
   `hub.submitCots()`. Needs the sync complete for the hub contract and the `api/stateful/` producer.
4. **Streaming inputs (WebSocket/gRPC via Fargate)** — largest net-new infrastructure surface; do
   last, and only for sources that genuinely cannot be polled or pushed via webhook.

Note the reordering from the original draft: agents moved ahead of streaming inputs, because
upstream's hub removed most of the agent send-path work while streaming inputs gained nothing.

## Open risks / things not yet decided

- **Hub is a single instance.** Upstream's `StatefulService` runs `DesiredCount: 1` and does not shard
  Connections across replicas. The web/API tier can now scale independently (the win that matters),
  but the hub itself remains a single point of failure and a scaling ceiling. Upstream mitigates with
  a deployment circuit breaker and container `RestartPolicy`, not redundancy. Unchanged from the
  original draft's concern, now confirmed as upstream's design too.
- **Fargate cost/ops for streaming Layers.** Each is always-on, not scale-to-zero. Needs per-layer
  monitoring and alarms mirroring what Lambda-per-Layer gets today, so many streaming sources don't
  become a silent cost surprise.
- **gRPC library maturity.** `@grpc/grpc-js` is solid, but this is new protocol surface for this
  codebase — proto management, versioning, and reconnect semantics for long-lived streams need their
  own design pass, not assumed to be a drop-in alongside the WebSocket case.
- **Agent chat addressing correctness.** `sendChat()` needs coverage against real TAK Server behavior
  for both one-to-one and mission/group chat before agents are trusted in production. This is the same
  protocol subtlety that has already caused bugs in the human-chat path.
- **Secrets for streaming/agent Layers.** Existing Layer secrets (`layers_incoming.environment`) are
  plaintext JSONB, not Secrets Manager. Bedrock credentials and streaming-source credentials should be
  reassessed against that pattern rather than assumed adequate, given the larger blast radius of
  always-on services versus short-lived Lambdas.
- **Divergence risk on `api/stateful/`.** The agent inbound producer (item 3) modifies a tree upstream
  actively develops. Keep that change as small and additively-shaped as possible, and register it in
  `docs/fork/FORK-DELTA.md` so it survives future syncs.

## Upstream issue tracking

_Searched `dfpc-coe/CloudTAK` issues on 2026-08-20._

| Item | Upstream issue | State | Author | Notes |
|---|---|---|---|---|
| 1. Hub/Gateway split | [#738 Resilient Infrastructure](https://github.com/dfpc-coe/CloudTAK/issues/738) | **Closed** 2026-07-20 | `ingalls` (maintainer) | Upstream's own tracking issue; shipped in v13.70.0 |
| 2. Streaming inputs | [#1555 Streaming KML](https://github.com/dfpc-coe/CloudTAK/issues/1555) | Open | `cmlaird` | **Partial only** — streaming KML import, not generalized persistent-connection inputs |
| 3. GeoChat AI agents | [#1282 Bi-Directional "Interactive Bot" Framework](https://github.com/dfpc-coe/CloudTAK/issues/1282) | Open | `chriselsen` (us) | Upstream-triaged: `enhancement`, `Priority: High`, `etl-tasks` |
| 4. KMZ network-link output | [#1558 Full KML/KMZ NetworkLink Support with Live Refresh](https://github.com/dfpc-coe/CloudTAK/issues/1558) | Open | `chriselsen` (us) | Unlabelled |

**Item 1 was a shared problem, not just ours.** #738 was filed by the upstream maintainer, cc'ing
`@chriselsen`, and describes the same analysis as this document:

> CloudTAK currently is partially stateful in that a single connection should be opened for each
> profile or machine connection. These connections don't scale well horizontally… Split the service
> into a stateful connection pooling service with DesiredCount=1 and an API operations service with
> DesiredCount=n… the stateless API would then post data via an internal API.

Notably it was triggered by a production incident (an ESRI→vector-tile CPU spike failing health checks
and terminating the task, taking down every user and machine connection at once). That is a concrete
availability argument for prioritising the v13.70.0 sync.

**Items 3 and 4 are on record but were filed by us.** #1282 carries upstream's own `Priority: High` /
`etl-tasks` labels, so the concept has been triaged and accepted, but neither issue has upstream
implementation activity. Do not plan on upstream delivering these.

**Item 2 was the only unfiled component — now filed as
[#1678 Persistent-Connection ETL Inputs (WebSocket / gRPC)](https://github.com/dfpc-coe/CloudTAK/issues/1678)**
(2026-08-20). It generalizes #1555's format-specific request and explicitly argues *against* hosting
stream clients in the new stateful hub service, since #738 was filed precisely because a CPU spike in
that process took down every TAK connection — putting arbitrary per-Layer code there would re-introduce
that failure mode. Filing it now, rather than later, was deliberate: it puts that design constraint on
record before anyone picks up #1555 and reaches for the always-on service as the path of least
resistance.

### Related open bugs (block item 3 regardless of framework choice)

- [#1290](https://github.com/dfpc-coe/CloudTAK/issues/1290) — TAK chat broken for non-connected clients
  (bots & automated systems), `Priority: High`
- [#1314](https://github.com/dfpc-coe/CloudTAK/issues/1314) — chat messages not displayed/sent when
  chatting with bot/non-connected contacts
- [#798](https://github.com/dfpc-coe/CloudTAK/issues/798) *(closed)* — persistent state management for
  Lambda ETL tasks; relevant to item 3's conversation-state design

### On a "master" umbrella issue upstream

**Not recommended.** Considered and rejected (2026-08-20) for five reasons:

1. **Incompatible upstream status.** Item 1 is closed and shipped (#738); items 3 and 4 are open and
   already filed (#1282, #1558); item 2 is now #1678. An umbrella would duplicate live issues and
   re-open settled ground.
2. **It would fragment the discussion that already has traction.** #1282 carries upstream's own
   `Priority: High` / `etl-tasks` labels. Folding that into a broader issue trades an actionable,
   scoped request for one that is harder to label, harder to close, and easier to defer.
3. **Bundling risks blanket deprioritisation.** The set mixes capabilities upstream evidently wants
   (the bot framework) with items closer to TAK.NZ-specific product direction (KMZ network-links driven
   by our LINZ/ArcGIS sources). Presented together they read as one fork's roadmap; presented
   separately each is judged on merit.
4. **The maintainer's pattern is issue-per-concern.** #738 shows upstream opens its own architecture
   issues when it intends to own a problem, and cc's us rather than asking for consolidation.
5. **We already have an umbrella — this document.** It serves our sequencing and design needs without
   an upstream mirror.

**The one case that would change this:** if we decide to *contribute implementations* upstream rather
than carry them in the fork. Then a short design RFC — a GitHub **Discussion** rather than an issue,
since it spans several issues and is a design conversation — referencing the existing tickets and paired
with a concrete offer to implement would be the right vehicle. Without an implementation offer attached
it is noise.

## Cross-references

- **`docs/fork/README-CDK-V13-HUB-SPLIT.md`** — infrastructure for the v13.70.0 hub split (item 1
  there). Item 1 of this document depended entirely on it; both are now complete and deployed.
- **Upstream [#1678](https://github.com/dfpc-coe/CloudTAK/issues/1678)** — the filed feature request for
  item 2 (persistent-connection ETL inputs). The local draft that became it has been removed.
- **`docs/fork/FORK-DELTA.md`** — where any fork-local changes from items 2–4 must be
  registered to survive upstream syncs.
