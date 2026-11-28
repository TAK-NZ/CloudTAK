#!/usr/bin/env bash
# Rotates the password of the CloudTAK break-glass account (ckadmin): sets a new random password in
# Authentik and in the sealed secret. See docs/BREAK_GLASS.md.
#
#   scripts/rotate-break-glass.sh TAK-Prod-CloudTAK [region]
#
# Run it with credentials that may invoke the function: the break-glass role (after assuming it with MFA)
# or an account administrator. The output holds the new secret version id and never the password.
set -euo pipefail

STACK="${1:-}"
REGION="${2:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "$STACK" ]; then
  echo "usage: $0 <cloudformation-stack-name, e.g. TAK-Prod-CloudTAK> [region]" >&2
  exit 2
fi
REGION_ARGS=()
if [ -n "$REGION" ]; then REGION_ARGS=(--region "$REGION"); fi

FUNCTION="$(aws cloudformation describe-stacks "${REGION_ARGS[@]}" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?contains(OutputKey,'BreakGlassRotateFunction')].OutputValue | [0]" --output text)"
if [ -z "$FUNCTION" ] || [ "$FUNCTION" = "None" ]; then
  echo "No BreakGlassRotateFunction output on stack $STACK. Is the stack deployed with the break-glass construct?" >&2
  exit 1
fi

echo "Rotating the break-glass password with $FUNCTION ..." >&2
OUT="$(mktemp)"
trap 'unlink "$OUT"' EXIT
aws lambda invoke "${REGION_ARGS[@]}" --function-name "$FUNCTION" \
  --cli-binary-format raw-in-base64-out --payload '{}' "$OUT" >/dev/null
cat "$OUT"; echo

if grep -q '"errorMessage"' "$OUT"; then
  echo "Rotation FAILED. Read the message above. Nothing is lost: see 'If a rotation fails' in docs/BREAK_GLASS.md." >&2
  exit 1
fi
echo "Rotated. The new password is in the sealed secret only." >&2
