# CDK Test Organization

## Testing philosophy

This suite follows one rule: **a test is worth keeping only if it can fail when
something is wrong, and cannot fail merely because the infrastructure changed on
purpose or a CDK library version bumped.**

We do not chase a coverage percentage. `npm run test:coverage` reports coverage,
it does not gate on it, and there is no `coverageThreshold`. A line-percentage
goal pushes toward tautological tests (asserting a value the construct just
typed three lines away) that pass because someone typed the same literal twice
and go red the moment you legitimately change the config. The gate is: **synth
succeeds, and the behavioral/safety assertions pass.**

Concretely, we keep:

- **Decision-logic unit tests** — pure functions with interesting boundaries:
  context/override resolution (including the strict-boolean flag rule — a flag
  is armed only by the exact string `'true'`), config validation, tag builders.
- **The full-stack synth-smoke test** — the single highest-value CDK test.
- **Behavioral / safety-property assertions** — properties whose meaning goes
  beyond restating construct code: prod data-loss safety, feature-flag-gated
  wiring, security-relevant network exposure, and the cross-stack export
  contract.

We deliberately do **not** keep full-template snapshots, "config has property X"
tautologies, one-assertion-per-resource restatements, or assertions on CDK's own
output (logical-id hashes, `Ref`/`Fn::GetAtt` shapes, `DeletionPolicy`
attributes that a construct produced automatically).

## Suite structure

### `test/unit/stack-synth.test.ts` — full-stack synth (highest value)

Synthesizes the whole `CloudTakStack` for each environment (`dev-test`, `prod`)
and each image path (local Docker build vs prebuilt ECR), asserting synth does
not throw. On top of the same synthesized templates it makes a small number of
behavioral/safety assertions:

- **Database safety shape** — prod carries `DeletionProtection: true` and runs
  provisioned instances (`db.t4g.large` × 2); dev-test is serverless v2 and
  destroyable (`DeletionProtection: false`).
- **Feature-flag-gated wiring** — `usePreBuiltImages` switches the container
  image source: local build sources from the CDK bootstrap asset repo, the
  prebuilt path from the imported BaseInfra ECR repo. Both branches are pinned.
- **Cross-stack export contract** — the `TAK-<Env>-CloudTAK-*` export names that
  other stacks import by name. A rename here breaks a consumer stack.

> Note: the prebuilt-image path resolves tags from a `cloudtakImageTag` context
> value that CI supplies. The synth helper mirrors this; without it the events
> and retention services throw at synth.

### `test/unit/utils/` — decision-logic unit tests

- **context-overrides.test.ts** — override merging, and the strict-boolean rule
  (`'true'` arms a flag; `'TRUE'`/`'1'`/`'yes'`/`' true '` do not). Guards
  against a refactor to a loose truthy check.
- **tag-helpers.test.ts** — standard tag generation and the project/component
  default fallbacks.

### `test/unit/constructs/` — targeted behavioral tests

These assert construct behavior the full-stack synth does not vary or does not
assert. Each names the bug it guards against:

- **alarms.test.ts** — alarm thresholds/statistics, the ELB 5XX fast + sustained
  windows, p99 latency, RDS `FreeLocalStorage` (a deliberate deviation from
  upstream's `FreeStorageSpace`), and stateful-alarm gating on the hub service.
- **cloudtak-stateful.test.ts** — hub-mode selection, single-task/no-autoscale
  invariant, port mappings (5000/5002), WebSocket-only routing on `/api`,
  private-subnet placement, and the hub RPC listener not being open to
  `0.0.0.0/0`.
- **dashboard.test.ts** — one dashboard per stack/region, the full widget set,
  and Aurora capacity/storage metrics (not upstream `FreeStorageSpace`).
- **etl-role.test.ts** — the ETL IAM role's assume-role principal and its S3 /
  KMS / Secrets Manager grants.
- **cloudtak-api.test.ts** — the ETL repository name injected into the container
  environment (read by the ETL layer subsystem).
- **lambda-functions.test.ts** — the PMTiles API Gateway name.
- **load-balancer.test.ts** — ALB scheme, HTTPS listener, and target-group
  wiring for the ECS service.
- **database.test.ts** — serverless vs provisioned selection, performance
  insights, and the missing-config error path.
- **route53.test.ts** — `serviceUrl` derivation and dual-stack (A + AAAA) record
  creation.
- **s3-resources.test.ts** — encryption, the versioning flag, `removalPolicy`
  branch, and optional S3-event-notification wiring.
- **secrets.test.ts** — the four API secrets, their names, KMS encryption, and
  the generated admin-password policy.
- **security-groups.test.ts** — the exact media ports exposed to `0.0.0.0/0`
  (a security-relevant contract).

### `test/__helpers__/` and `test/__fixtures__/`

- **synth-stack.ts** — `synthTemplate(envType, extraContext)`: reads the env's
  `cdk.json` context, applies overrides, instantiates `CloudTakStack` with an
  explicit `env: { account, region }` (so `stack.availabilityZones` resolves
  real AZs), and returns `Template.fromStack(stack)`.
- **cdk-test-utils.ts** — mock VPC / infrastructure / network / secret helpers
  for the targeted construct tests.
- **mock-configs.ts** — reusable `DEV_TEST` / `PROD` / `MINIMAL` config objects.

## The litmus test before keeping any test

1. Could this fail for a reason other than a real defect (a purposeful infra
   change, a library bump)? → maintenance tax; delete or narrow it.
2. Does it assert something typed verbatim nearby? → tautology; delete.
3. If you introduce the bug it's meant to catch, does it actually go red? → if
   you can't name the bug, it isn't guarding anything.

## Running tests

```bash
npm test               # run everything
npm run test:unit      # run test/unit
npm run test:coverage  # report coverage (does not gate)
npm run test:watch     # watch mode
```
