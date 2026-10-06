# CloudTAK Inbound Email for ETL Layers

ETL layers with **Email Delivery** enabled receive messages sent to
`<layer uuid>@mail.<api hostname>.<zone>` (for example
`<uuid>@mail.map.tak.nz`). The infrastructure is the CDK port of upstream's
`cloudformation/mail.template.js` (v13.102.4) and lives in
`cdk/lib/constructs/mail.ts`.

There is no feature flag: like Webhooks, it is deployed with every stack.

## Flow

1. The sender's mail server resolves the **MX record** and delivers to the SES
   Mail Manager **ingress point**.
2. The **traffic policy** accepts only recipients ending in `@<mail domain>`
   (default DENY) and messages up to 10 MiB.
3. The **rule set** runs two rules: `ArchiveAll` (Mail Manager archive, kept
   when the stack is deleted), then `DeliverLayers` (write raw MIME to the mail
   bucket, then invoke the router Lambda asynchronously).
4. The **router Lambda** (`TAK-<Env>-CloudTAK-mail-router`) reads the SSM
   parameter `<layer prefix><uuid>` (JSON `{arn, senders}`), applies the
   per-layer sender allow-list, and async-invokes the layer function with
   `{type: 'email', bucket, key, mail, receipt}`.
5. The layer reads the raw message from the mail bucket (its role, `TAK-<Env>-CloudTAK-etl`,
   has `s3:GetObject` on it).

The SSM parameter is created by the API inside each layer's own CloudFormation
stack, which is why the API task role has `ssm:PutParameter` and friends on the
layer prefix.

## DNS records created

Both are created in the hosted zone that CloudTAK and Webhooks already use.

| Record | Name | Value |
|--------|------|-------|
| MX | `mail.<hostname>.<zone>` | `10 <ingress point A record>` |
| TXT | `_dmarc.mail.<hostname>.<zone>` | `v=DMARC1; p=none;` |

The mail domain is `mail.` + the API host. It must equal `MAIL_DOMAIN` as the API
computes it (`api/common/config.ts`); the CDK sets `MAIL_DOMAIN` explicitly on
both the stateless and stateful containers from the same rule. Do not point
another MX at that name.

## Resources

| Resource | Notes |
|----------|-------|
| `AWS::SES::MailManagerTrafficPolicy` | DENY by default, ALLOW recipient `ENDS_WITH @<mail domain>`, 10 MiB max |
| `AWS::SES::MailManagerArchive` | 6 month retention, `Retain` on stack deletion |
| `AWS::SES::MailManagerRuleSet` | `ArchiveAll`, then `DeliverLayers` (WriteToS3 + InvokeLambda EVENT) |
| `AWS::SES::MailManagerIngressPoint` | `OPEN`, TLS `OPTIONAL` |
| S3 bucket | `tak-<env>-cloudtak-mail-<account>-<region>`, SSE-S3, all public access blocked, objects expire after 7 days, incomplete multipart uploads abort after 1 day |
| Router Lambda | Node.js 24, 128 MB, 30 s, logs kept 7 days. Code is `cdk/lib/lambda/mail-router.cjs`, a verbatim copy of upstream `cloudformation/lib/mail-lambda.cjs` |
| Router alarms | Errors > 0, Throttles > 0, Duration p99 > 25 s, to the high-urgency topic |

The 7 day expiry, archive retention and size limit are props on the `Mail`
construct (`mailExpirationDays`, `archiveRetentionPeriod`, `maxMessageSizeBytes`).

## CloudFormation exports

| Export | Value |
|--------|-------|
| `TAK-{Env}-CloudTAK-mail-layer-prefix` | `/TAK-{Env}-CloudTAK/mail/layer/` (imported by layer stacks) |
| `TAK-{Env}-CloudTAK-mail-bucket` | Mail bucket name |
| `TAK-{Env}-CloudTAK-mail-domain` | Mail domain |
| `TAK-{Env}-CloudTAK-mail-ingress-point-id` | Ingress point ID |
| `TAK-{Env}-CloudTAK-mail-ingress-point-arecord` | Ingress point A record (MX target) |
| `TAK-{Env}-CloudTAK-mail-archive-id` | Archive ID |

The API finds the layer prefix through a small fork patch,
`Lambda.siblingExport()` in `api/stateless/lib/aws/lambda.ts`
(see [`fork/FORK-DELTA.md`](fork/FORK-DELTA.md)).

## Security notes

- The ingress point is **OPEN**: public SMTP, reachable by anyone, with TLS
  optional. There is no authentication of inbound mail.
- Exposure is bounded by the traffic policy: only recipients at the mail domain,
  10 MiB per message.
- Each layer has a sender allow-list matched against the `From` header. An empty
  list accepts **any** sender, and `From` can be forged, so treat it as a filter
  and not a security boundary. DMARC is `p=none` (monitor only).
- Raw mail stays in S3 for 7 days and in the Mail Manager archive for 6 months.
  Do not send sensitive content to a layer address.
- SES Mail Manager inbound is available in ap-southeast-2 (Sydney).
- The standard `Environment Type` tag is not applied to the four Mail Manager
  resources because SES rejects tag keys containing spaces.
