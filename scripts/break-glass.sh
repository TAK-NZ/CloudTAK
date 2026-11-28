#!/usr/bin/env bash
# Break-glass helper for the CloudTAK emergency account (ckadmin). See docs/BREAK_GLASS.md.
#
#   scripts/break-glass.sh <stack> <command> [options]
#
#   <stack>        the CloudTAK stack, for example TAK-Prod-CloudTAK
#
# Commands
#   read           assume the break-glass role (MFA) and print the username and password
#                  Every use of this sends the alarm email in production.
#   rotate         assume the role and rotate the password (prints no password)
#   credentials    print `export` lines for the role's temporary credentials, so that you can run your own commands:
#                    eval "$(scripts/break-glass.sh TAK-Prod-CloudTAK credentials)"
#
# Options
#   --region R         AWS Region (default: AWS_REGION or AWS_DEFAULT_REGION)
#   --mfa-serial ARN   your MFA device (default: the first MFA device of the calling IAM user)
#   --token-code N     the current 6-digit MFA code (default: asked for)
#   --no-mfa           for a role that does not require MFA (cloudtak.breakGlass.roleRequireMfa=false)
#   --role-arn ARN     the role (default: the BreakGlassRoleArn output of the stack)
#   --duration SEC     lifetime of the temporary credentials, 900 to 3600 (default 900)
#
# Run it with your own credentials: exported AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (as copied from the
# SSO portal), or a profile (after `aws sso login`). The role's credentials are used only for the one
# command, and are never written to a file. The session name carries your user name, so CloudTrail shows who it was.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "break-glass: $*" >&2; exit 1; }

[ $# -ge 2 ] || usage
STACK="$1"; COMMAND="$2"; shift 2
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
MFA_SERIAL=""; TOKEN_CODE=""; NO_MFA=0; ROLE_ARN=""; DURATION=900
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --mfa-serial) MFA_SERIAL="${2:?--mfa-serial needs a value}"; shift 2 ;;
    --token-code) TOKEN_CODE="${2:?--token-code needs a value}"; shift 2 ;;
    --no-mfa) NO_MFA=1; shift ;;
    --role-arn) ROLE_ARN="${2:?--role-arn needs a value}"; shift 2 ;;
    --duration) DURATION="${2:?--duration needs a value}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "break-glass: unknown option $1" >&2; usage ;;
  esac
done
case "$COMMAND" in read|rotate|credentials) ;; *) echo "break-glass: unknown command $COMMAND" >&2; usage ;; esac
case "$DURATION" in ''|*[!0-9]*) die "--duration must be a number of seconds" ;; esac
if [ "$DURATION" -lt 900 ] || [ "$DURATION" -gt 3600 ]; then die "--duration must be between 900 and 3600 seconds"; fi

# "Your own credentials" are whatever the AWS CLI uses now: AWS_PROFILE (for example an IAM Identity Center profile after
# `aws sso login`), or environment keys. Nothing here changes that.
REGION_ARGS=()
if [ -n "$REGION" ]; then REGION_ARGS=(--region "$REGION"); fi

stack_output() {
  aws cloudformation describe-stacks "${REGION_ARGS[@]}" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?contains(OutputKey,'$1')].OutputValue | [0]" --output text
}

if [ -z "$ROLE_ARN" ]; then
  ROLE_ARN="$(stack_output BreakGlassRoleArn)"
  if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
    die "no BreakGlassRoleArn output on stack $STACK. Is the stack deployed with the break-glass construct? (or pass --role-arn)"
  fi
fi

ASSUME_ARGS=(--role-arn "$ROLE_ARN" --duration-seconds "$DURATION")
if [ "$NO_MFA" -eq 0 ]; then
  if [ -z "$MFA_SERIAL" ]; then
    MFA_SERIAL="$(aws iam list-mfa-devices --query 'MFADevices[0].SerialNumber' --output text 2>/dev/null || true)"
    if [ -z "$MFA_SERIAL" ] || [ "$MFA_SERIAL" = "None" ]; then
      die "no MFA device found for the calling user. The role needs MFA: pass --mfa-serial <ARN of your device> (or --no-mfa if the role does not require it)"
    fi
  fi
  if [ -z "$TOKEN_CODE" ]; then
    [ -r /dev/tty ] || die "no terminal to ask for the MFA code on: pass --token-code"
    printf 'MFA code for %s: ' "$MFA_SERIAL" >&2
    read -r TOKEN_CODE < /dev/tty
  fi
  case "$TOKEN_CODE" in [0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) die "the MFA code is 6 digits" ;; esac
  ASSUME_ARGS+=(--serial-number "$MFA_SERIAL" --token-code "$TOKEN_CODE")
fi
# The session name appears in CloudTrail and in the alarm email's caller
WHO="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null | sed -e 's#.*/##' -e 's/[^A-Za-z0-9=,.@_-]/-/g' | cut -c1-40)"
ASSUME_ARGS+=(--role-session-name "break-glass-${WHO:-unknown}")

# One line: access key, secret key, session token, expiry. Held in shell variables only.
CREDS="$(aws sts assume-role "${REGION_ARGS[@]}" "${ASSUME_ARGS[@]}" \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken,Expiration]' --output text)" \
  || die "could not assume $ROLE_ARN"
read -r AK SK ST EXPIRES <<< "$CREDS"
unset CREDS
[ -n "${AK:-}" ] && [ -n "${SK:-}" ] && [ -n "${ST:-}" ] || die "the credentials in the response are incomplete"
echo "Assumed the break-glass role. The credentials expire at $EXPIRES." >&2

# Runs a command as the role, without exporting its credentials to anything else
# (-u AWS_PROFILE: a profile in the environment must not take precedence over the role's keys)
as_role() { env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST" "$@"; }

case "$COMMAND" in
  credentials)
    echo "unset AWS_PROFILE"
    echo "export AWS_ACCESS_KEY_ID='$AK'"
    echo "export AWS_SECRET_ACCESS_KEY='$SK'"
    echo "export AWS_SESSION_TOKEN='$ST'"
    echo "Run the eval in a shell you will close afterwards: those credentials stay in its environment." >&2
    ;;
  read)
    SECRET_NAME="$(stack_output BreakGlassSecretName)"
    if [ -z "$SECRET_NAME" ] || [ "$SECRET_NAME" = "None" ]; then die "no BreakGlassSecretName output on stack $STACK"; fi
    SECRET="$(as_role aws secretsmanager get-secret-value "${REGION_ARGS[@]}" --secret-id "$SECRET_NAME" \
      --query SecretString --output text)" || die "could not read $SECRET_NAME"
    USERNAME="$(printf '%s' "$SECRET" | sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    PASSWORD="$(printf '%s' "$SECRET" | sed -n 's/.*"password"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    unset SECRET
    [ -n "$USERNAME" ] && [ -n "$PASSWORD" ] || die "the secret does not hold a username and a password"
    echo "username: $USERNAME"
    echo "password: $PASSWORD"
    echo "This read was recorded and raises the alarm in production. When you are done: $0 $STACK rotate" >&2
    ;;
  rotate)
    # The role may invoke the function but may not describe stacks, so the name comes from your own credentials
    FUNCTION="$(stack_output BreakGlassRotateFunction)"
    if [ -z "$FUNCTION" ] || [ "$FUNCTION" = "None" ]; then die "no BreakGlassRotateFunction output on stack $STACK"; fi
    OUT="$(mktemp)"
    trap 'unlink "$OUT"' EXIT
    echo "Rotating the break-glass password with $FUNCTION ..." >&2
    as_role aws lambda invoke "${REGION_ARGS[@]}" --function-name "$FUNCTION" \
      --cli-binary-format raw-in-base64-out --payload '{}' "$OUT" >/dev/null || die "could not invoke $FUNCTION"
    cat "$OUT"; echo
    if grep -q '"errorMessage"' "$OUT"; then die "rotation FAILED. Read the message above; see 'If a rotation fails' in docs/BREAK_GLASS.md"; fi
    echo "Rotated. Now restart the LDAP service so that the old password stops working at once (docs/BREAK_GLASS.md)." >&2
    ;;
esac
