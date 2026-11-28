# Break-glass account (`ckadmin`)

`ckadmin` is the CloudTAK local system administrator. It is the last way in when signing in through Authentik is not
possible, for example when Authentik is down or every administrator is locked out. It is the only account that may
sign in to CloudTAK without going through Authentik (`localOnlyAccounts`), and it does not use MFA. Because of that, its
password is sealed: nothing injects it, almost nobody can read it, and any use is reported.

## How it works

| Piece | What it does |
|---|---|
| Secret `TAK-<stack>-CloudTAK/API/Admin-Password` | Holds the username and the password. The CloudTAK container never receives the password, only the username. |
| Provisioning function `TAK-<stack>-CloudTAK-BreakGlassProvision` | Runs on every deploy. Creates `ckadmin` in Authentik if it is missing, puts it in the `tak-break-glass` group, and keeps a rotation token. It **never resets the password of an existing account**. |
| `tak-break-glass` group (created by auth-infra) | The web login flows refuse its members, so `ckadmin` cannot sign in through the Authentik web pages. CloudTAK's local sign-in is unaffected. |
| Rotation function `TAK-<stack>-CloudTAK-BreakGlassRotate` | Sets a new random password in Authentik and in the secret. Runs only when you invoke it. |
| Rotation token | An Authentik service account (`tak-break-glass-rotator`) that can view and reset the password of `ckadmin` and nothing else. It sees one user, and gets a refusal on every other account, group, flow, provider, event and blueprint. Kept in the secret `TAK-<stack>-CloudTAK/API/Admin-Rotation`, which only the two functions read. |
| Role `TAK-<stack>-CloudTAK-BreakGlass` | The only reader of the sealed secret. It is assumed with MFA, for at most one hour. |

## Configuration

In `cdk/cdk.json`, per environment, under `cloudtak.breakGlass`. Every field is optional.

| Field | Meaning | Override (`-c`) |
|---|---|---|
| `sealed` | `true` seals the secret and turns the alarms on. Default `false`. | `breakGlassSealed=true` |
| `alertEmails` | Addresses that receive the alarms. | `breakGlassAlertEmails=a@x.nz,b@x.nz` |
| `roleTrustedPrincipals` | IAM role or user ARNs that may assume the break-glass role. Empty: the role trusts the account, so anyone in it with `sts:AssumeRole` rights, with MFA. | `breakGlassRoleTrustedPrincipals=arn:...,arn:...` |
| `roleRequireMfa` | Require MFA on the assume-role call. Default `true`. Set `false` only with named principals that are IAM Identity Center roles, whose sessions carry no MFA flag. | `breakGlassRoleRequireMfa=false` |

### Demo and Test compared with production

Production has `sealed: true`; Demo and Test have `sealed: false`. Everything else is the same everywhere.

| | Demo and Test (`sealed: false`) | Production (`sealed: true`) |
|---|---|---|
| Deploy | Never resets the `ckadmin` password | Same |
| CloudTAK container | Username only | Same |
| Reading the secret | Any account administrator, no alarm | Only the break-glass role. Everyone else is denied, administrators included. |
| Alarms | None | An email on any read of the secret or refused attempt to read it (except by the two functions), on any LDAP bind as `ckadmin`, and on a change to the secret's resource policy (a change made by a deploy is not one) |
| Signing in as `ckadmin` | Works, no alert | Works, and alerts |

With `sealed: true` and no `alertEmails`, the alarms still exist and show in CloudWatch and EventBridge, but nobody is
notified. A deploy-time warning says so.

## Who can assume the role, and MFA

The role asks for MFA on the assume-role call by default (`roleRequireMfa: true`). That works for IAM users with an MFA
device. **It does not work for IAM Identity Center (SSO) users**: an SSO session carries no `aws:MultiFactorAuthPresent`
flag, so the condition would refuse everyone. If you sign in to AWS through SSO, set, for that environment:

```json
"breakGlass": {
  "roleRequireMfa": false,
  "roleTrustedPrincipals": ["arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/<sso-region>/AWSReservedSSO_<PermissionSet>_<hash>"]
}
```

(`roleRequireMfa: false` is accepted only with named principals, so the role never trusts the whole account without MFA.)

- Find the ARN after `aws sso login`: `aws sts get-caller-identity` shows
  `arn:aws:sts::<account>:assumed-role/AWSReservedSSO_<PermissionSet>_<hash>/<you>`. The role to trust is the same name
  under `role/aws-reserved/sso.amazonaws.com/<sso-region>/`. It is the permission set that is trusted, so everyone who
  holds that permission set in that account can assume the break-glass role.
- Trust the narrowest permission set that fits, not an administrator-wide one if a smaller group will do.
- If the permission set is deleted and recreated, its role ARN changes and the trust stops matching. Update the
  configuration and deploy.
- Without MFA on the AWS side, the protection is the strength of the SSO sign-in itself (enforce MFA at the identity
  provider if you can), the short session, and the alarms on every read and every sign-in.

## Using it in an emergency (production)

`scripts/break-glass.sh` does the assume-role and the read in one step. Run it with your own credentials (after
`aws sso login` for an SSO profile, with `AWS_PROFILE` set as usual):

```bash
# IAM user with an MFA device: it finds your device and asks for the code
scripts/break-glass.sh TAK-Prod-CloudTAK read

# IAM Identity Center, or any role that does not require MFA
scripts/break-glass.sh TAK-Prod-CloudTAK read --no-mfa
```

It assumes the role (15 minutes, session name `break-glass-<you>` so CloudTrail shows who), reads the secret as the role,
and prints the username and password on standard output. Nothing is written to a file. **The read sends the alarm email.**

1. Run the command above.
2. Sign in to CloudTAK with that username and password. **This sends the second alarm email.**
3. Fix what you came to fix, and sign out.
4. **Rotate the password**, so the value you read is replaced. Do this every time, whatever the reason:
   `scripts/break-glass.sh TAK-Prod-CloudTAK rotate --no-mfa` (it runs the rotation as the role).
5. Restart the LDAP service (below), because until you do, the old password still works.

For your own commands as the role, `eval "$(scripts/break-glass.sh TAK-Prod-CloudTAK credentials)"` puts the role's
temporary credentials in the current shell. Run it in a shell you close afterwards.

Without the script, by hand: `aws sts assume-role --role-arn <BreakGlassRoleArn> --role-session-name emergency
--duration-seconds 900` (plus `--serial-number <your MFA device ARN> --token-code <code>` when MFA is required),
then use the returned keys for `aws secretsmanager get-secret-value --secret-id <BreakGlassSecretName>`.

## Rotating the password

```bash
scripts/break-glass.sh TAK-Prod-CloudTAK rotate --no-mfa       # as the break-glass role (drop --no-mfa to use an MFA device)
scripts/rotate-break-glass.sh TAK-Prod-CloudTAK ap-southeast-2 # with your own credentials, if you may invoke the function
```

Either one looks up the function name from the stack output and invokes it. It never prints the password.

### The old password keeps working until the LDAP outpost forgets it

Rotation changes the password in Authentik and in the secret at once. CloudTAK checks the password through the LDAP
outpost, and the outpost runs in *cached* bind mode: it remembers a password it has accepted, keyed on the account and
the password, for the rest of that login session (one hour here; reuse does not extend it). A rotation does not clear
that memory. On Test, after a rotation the old password was still accepted at every check for several minutes, and was
refused as soon as the LDAP service restarted.

So after a rotation that has to take effect now (every use of the credential in production), restart the LDAP service.
It is a rolling restart, so LDAP stays available:

```bash
aws ecs update-service --cluster TAK-<stack>-BaseInfra --service <the LDAPService service of TAK-<stack>-AuthInfra> \
  --force-new-deployment
```

Without the restart the old password stops working by itself within an hour of the last time it was accepted.

The script looks up the function name from the stack output and invokes it. The same thing by hand:

```bash
aws lambda invoke --function-name TAK-<stack>-CloudTAK-BreakGlassRotate \
  --cli-binary-format raw-in-base64-out --payload '{}' --region <region> /dev/stdout
```

Run it from any terminal or CloudShell, as the break-glass role or as an account administrator. It returns
`{"status":"rotated","secretVersion":"..."}` and never the password. Rotation never runs on a schedule.

What it does, in order: it generates a new password and stores it as a pending version of the secret (the current
version is untouched); it sets the password in Authentik with the rotation token; it makes the new version current.

### If a rotation fails

- **"Authentik refused the new password"**: nothing changed, and the old password is still the current one. Check that
  Authentik is up and that the provisioning function has run (deploy the stack again), then rotate again.
- **"The password was changed in Authentik but the new secret version ... could not be made current"**: the new
  password is in the pending version. The error message holds the exact command to make it current.
- **"The rotation secret is empty"**: deploy the stack again, which runs the provisioning function.

## First rollout in production

The password that exists before this change has been in the CloudTAK container environment, so after the first deploy
run the rotation once. The new password then exists only in the sealed secret.

## Quarterly test

Once a quarter, in production: run `scripts/break-glass.sh <stack> read`, sign in to CloudTAK as `ckadmin`, confirm that
you can reach the administration pages, sign out, rotate, and restart the LDAP service. Confirm that both alarm emails arrived, and keep the emails and the
date as the evidence of the test.

## What the alarms do not cover

- **Changes to the role.** IAM changes are recorded in `us-east-1` only, so a rule in the stack's Region cannot see
  them. A change to the secret's resource policy is covered; a change to the role's trust policy is not.
- **Administrators can still change the policies.** Sealing denies reads, not edits. An administrator who removes the
  seal is reported (policy change alarm), but not prevented.
- **CloudTrail must log read events.** The read alarm depends on a trail that logs management events, read and write,
  in the Region (base-infra creates it). Without it GetSecretValue is never seen.
- **Refused attempts count too.** The read alarm fires when an administrator is denied (the sealed secret refuses everyone but the break-glass role), and the bind alarm fires on any LDAP attempt as `ckadmin`, successful or not. CloudTrail redacts the request of a refused call, so the read rule also matches the secret's name in the error message.

## Recovering a sealed secret that no role can read

If the break-glass role has been deleted or its trust policy broken, nobody can read the secret. An account
administrator can repair the role, or remove the Deny statement from the secret's resource policy
(`aws secretsmanager delete-resource-policy`) and then restore it by deploying the stack. Both actions are reported.

## Requirements

- auth-infra must be deployed first: it creates the `tak-break-glass` group, and the provisioning function stops with a
  clear message when the group is missing.
- The LDAP outpost log group is named `LDAP` (auth-infra). The bind alarm is a metric filter on that log group.
