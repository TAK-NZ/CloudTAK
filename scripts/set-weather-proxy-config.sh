#!/bin/bash
# Write WEATHER_PROXY_URL / WEATHER_PROXY_KEY (and optionally WEATHER_RATE_LIMIT) into the live
# cloudtak-config.env in the BaseInfra config bucket, for the cloudtak-plugin-weather relay.
#
# The key is never printed, logged, put on a command line or passed in the environment of a
# subprocess. It is read from a mode 600 file (or a hidden prompt) and only ever written into a
# mode 600 file inside a mode 700 temp directory, which is removed on exit.
#
# TAK-NZ only. Not part of the CloudTAK image (scripts/** is excluded from the CDK asset).
set -euo pipefail

PROG="set-weather-proxy-config.sh"
OBJECT_KEY="cloudtak-config.env"
BEGIN_MARK="# BEGIN weather-proxy (managed by scripts/set-weather-proxy-config.sh)"
END_MARK="# END weather-proxy"
# The relay (api/stateless/lib/weather/relay-config.ts) only accepts [A-Za-z0-9._~-]{16,128}
RELAY_KEY_PATTERN='^[A-Za-z0-9._~-]{16,128}$'

usage() {
    cat <<EOF
Usage: scripts/$PROG --profile PROFILE --region REGION --url URL [options]

Sets WEATHER_PROXY_URL, WEATHER_PROXY_KEY and optionally WEATHER_RATE_LIMIT in
s3://<BaseInfra config bucket>/$OBJECT_KEY. All other lines are preserved.

Required:
  --profile PROFILE     AWS CLI profile (e.g. default for Test, tak-nz-demo for Demo)
  --region REGION       AWS region (e.g. us-west-2 for Test, ap-southeast-2 for Demo)
  --url URL             https base URL of the weather proxy, no query, fragment or
                        credentials; a trailing slash is removed

Options:
  --key-file FILE       File that contains only the key. Must be mode 600 or 400.
                        Without it the key is read from /dev/tty with a hidden prompt.
  --rate N              WEATHER_RATE_LIMIT (60..6000). Without it any existing
                        WEATHER_RATE_LIMIT line is removed and the relay default applies.
  --stack-name NAME     CloudFormation stack name (default: Demo). The bucket is read from
                        the export TAK-<NAME>-BaseInfra-EnvConfigBucket.
  --bucket NAME         Use this bucket instead of resolving the export
  --dry-run             Do everything except the upload
  --yes                 Do not ask for confirmation
  -h, --help            Show this help

Safety:
  * The bucket is not versioned, so the current file is first copied to
    \$HOME/.cloudtak-config-backups/<account>-<region>-<UTC time>.env (mode 600).
  * Existing WEATHER_PROXY_URL=, WEATHER_PROXY_KEY= and WEATHER_RATE_LIMIT= lines and the
    managed block are replaced by one managed block. Running it twice changes nothing.
  * The script never runs aws ecs. The API tasks read the file when they start, so a new
    deployment is needed afterwards; the command is printed at the end.

Example:
  scripts/$PROG --profile tak-nz-demo --region ap-southeast-2 \\
      --url https://utils.test.tak.nz/weather-radar --key-file ~/weather.key --dry-run
EOF
}

die() {
    echo "Error: $*" >&2
    exit 1
}

PROFILE=""
REGION=""
STACK_NAME="Demo"
URL=""
KEY_FILE=""
RATE=""
BUCKET=""
DRY_RUN=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
    opt="$1"
    val=""
    if [[ "$opt" == --*=* ]]; then
        val="${opt#*=}"
        opt="${opt%%=*}"
        set -- "$opt" "$val" "${@:2}"
    fi
    case "$opt" in
        -h|--help) usage; exit 0 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --yes) ASSUME_YES=1; shift ;;
        --profile|--region|--stack-name|--url|--key-file|--rate|--bucket)
            [ $# -ge 2 ] || die "$opt needs a value"
            case "$opt" in
                --profile) PROFILE="$2" ;;
                --region) REGION="$2" ;;
                --stack-name) STACK_NAME="$2" ;;
                --url) URL="$2" ;;
                --key-file) KEY_FILE="$2" ;;
                --rate) RATE="$2" ;;
                --bucket) BUCKET="$2" ;;
            esac
            shift 2
            ;;
        *) die "Unknown option: $opt (see --help)" ;;
    esac
done

[ -n "$PROFILE" ] || die "--profile is required"
[ -n "$REGION" ] || die "--region is required"
[ -n "$URL" ] || die "--url is required"
command -v aws >/dev/null 2>&1 || die "aws CLI not found"

[[ "$PROFILE" =~ ^[A-Za-z0-9._@:/-]+$ ]] || die "Invalid --profile"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || die "Invalid --region"
[[ "$STACK_NAME" =~ ^[A-Za-z0-9-]+$ ]] || die "Invalid --stack-name"
if [ -n "$BUCKET" ]; then
    [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "Invalid --bucket"
fi

# URL: https only, no whitespace, query, fragment or credentials; trailing slashes removed
while [[ "$URL" == */ ]]; do URL="${URL%/}"; done
[[ "$URL" =~ ^https://[^[:space:]?#@]+$ ]] || die "--url must be an https URL without whitespace, query, fragment or credentials"
[ "${#URL}" -le 200 ] || die "--url is longer than 200 characters (the relay would ignore it)"

if [ -n "$RATE" ]; then
    [[ "$RATE" =~ ^[0-9]{1,5}$ ]] || die "--rate must be a whole number"
    if [ "$RATE" -lt 60 ] || [ "$RATE" -gt 6000 ]; then die "--rate must be between 60 and 6000"; fi
fi

# Temp dir first, so every later failure is cleaned up
umask 077
TMP=""
cleanup() {
    if [ -n "$TMP" ] && [ -d "$TMP" ]; then
        rm -rf -- "$TMP"
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TMP="$(mktemp -d)"
chmod 700 "$TMP"

# Key: from a private file or a hidden prompt. It lives only in this shell variable.
KEY=""
if [ -n "$KEY_FILE" ]; then
    if [ ! -f "$KEY_FILE" ] || [ ! -r "$KEY_FILE" ]; then die "--key-file is not a readable file"; fi
    if mode="$(stat -c '%a' -- "$KEY_FILE" 2>/dev/null)"; then :; else mode="$(stat -f '%Lp' -- "$KEY_FILE")"; fi
    case "$mode" in
        600|400) ;;
        *) die "--key-file has mode $mode; it must be 600 or 400 (chmod 600 FILE)" ;;
    esac
    KEY="$(<"$KEY_FILE")"
else
    [ -r /dev/tty ] || die "No --key-file and no terminal to prompt on"
    IFS= read -rs -p "Weather proxy key (input hidden): " KEY </dev/tty || die "Could not read the key"
    echo >&2
fi
if [[ "$KEY" == *"<"* || "$KEY" == *">"* ]]; then
    die "The key looks like a placeholder"
fi
[[ "$KEY" =~ ^[A-Za-z0-9._~+/=-]{16,256}$ ]] || die "The key must be 16 to 256 characters of A-Z a-z 0-9 . _ ~ + / = - (one line, no spaces or quotes)"
if ! [[ "$KEY" =~ $RELAY_KEY_PATTERN ]]; then
    echo "Warning: the CloudTAK relay only accepts keys of 16 to 128 characters of A-Z a-z 0-9 . _ ~ -; with this key weather would stay disabled." >&2
fi

aws_() {
    aws --profile "$PROFILE" --region "$REGION" "$@"
}

ACCOUNT="$(aws_ sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || die "Could not determine the AWS account"

if [ -z "$BUCKET" ]; then
    EXPORT_NAME="TAK-${STACK_NAME}-BaseInfra-EnvConfigBucket"
    # list-exports is paginated and the CLI applies --query to every page, so a
    # "| [0]" projection prints "None" for each page without a match. Collect all
    # matches instead and keep the first real value.
    BUCKET="$(aws_ cloudformation list-exports --query "Exports[?Name==\`${EXPORT_NAME}\`].Value" --output text | tr '\t' '\n' | grep -v -e '^None$' -e '^$' | head -n 1 || true)"
    if [ -z "$BUCKET" ]; then
        die "CloudFormation export $EXPORT_NAME not found in account $ACCOUNT, region $REGION"
    fi
    [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "The export $EXPORT_NAME is not a bucket name"
fi
S3_URI="s3://${BUCKET}/${OBJECT_KEY}"

CURRENT="$TMP/current.env"
NEW="$TMP/new.env"
VERIFY="$TMP/verify.env"
echo "Account: $ACCOUNT  Region: $REGION  Object: $S3_URI"
aws_ s3 cp "$S3_URI" "$CURRENT" --only-show-errors || die "Could not download $S3_URI"

# Backup first: the bucket has no versioning
BACKUP_DIR="${HOME}/.cloudtak-config-backups"
if [ ! -d "$BACKUP_DIR" ]; then mkdir -m 700 "$BACKUP_DIR"; fi
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_DIR/${ACCOUNT}-${REGION}-${STAMP}.env"
n=1
while [ -e "$BACKUP" ]; do
    BACKUP="$BACKUP_DIR/${ACCOUNT}-${REGION}-${STAMP}-${n}.env"
    n=$((n + 1))
done
cp -- "$CURRENT" "$BACKUP"
chmod 600 "$BACKUP"
echo "Backup written: $BACKUP"

# Everything except the weather variables and the managed block, byte for byte.
# Fails when a BEGIN marker has no END marker.
strip_weather() {
    LC_ALL=C awk -v begin="$BEGIN_MARK" -v end="$END_MARK" '
        skip { if ($0 == end) skip = 0; next }
        $0 == begin { skip = 1; next }
        /^(export[ \t]+)?WEATHER_(PROXY_URL|PROXY_KEY|RATE_LIMIT)=/ { next }
        { print }
        END { if (skip) exit 3 }
    ' "$1"
}

strip_weather "$CURRENT" > "$NEW" || die "$S3_URI has a '$BEGIN_MARK' line without a matching '$END_MARK' line; fix it by hand"
{
    printf '%s\n' "$BEGIN_MARK"
    printf 'WEATHER_PROXY_URL=%s\n' "$URL"
    printf 'WEATHER_PROXY_KEY=%s\n' "$KEY"
    if [ -n "$RATE" ]; then printf 'WEATHER_RATE_LIMIT=%s\n' "$RATE"; fi
    printf '%s\n' "$END_MARK"
} >> "$NEW"

EXPECTED_NAMES="WEATHER_PROXY_KEY WEATHER_PROXY_URL"
if [ -n "$RATE" ]; then EXPECTED_NAMES="WEATHER_PROXY_KEY WEATHER_PROXY_URL WEATHER_RATE_LIMIT"; fi

names_in() {
    LC_ALL=C sed -n -E 's/^WEATHER_(PROXY_URL|PROXY_KEY|RATE_LIMIT)=.*/WEATHER_\1/p' "$1" | sort | tr '\n' ' ' | sed 's/ $//'
}
removed="$(LC_ALL=C sed -n -E 's/^(export[[:space:]]+)?(WEATHER_(PROXY_URL|PROXY_KEY|RATE_LIMIT))=.*/\2/p' "$CURRENT" | sort | tr '\n' ' ' | sed 's/ $//')"
kept_lines="$(strip_weather "$CURRENT" | wc -l | tr -d ' ')"

echo
echo "Change summary for $S3_URI"
echo "  Replaced existing weather lines : ${removed:-none}"
echo "  Other lines kept unchanged      : $kept_lines"
echo "  Managed block now contains      :"
echo "    WEATHER_PROXY_URL=$URL"
echo "    WEATHER_PROXY_KEY=<set>"
if [ -n "$RATE" ]; then
    echo "    WEATHER_RATE_LIMIT=<set>"
else
    echo "    (no WEATHER_RATE_LIMIT; the relay default applies)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo
    echo "Dry run: nothing was uploaded."
    exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
    [ -r /dev/tty ] || die "No terminal to confirm on; use --yes"
    echo
    reply=""
    IFS= read -r -p "Upload to $S3_URI in account $ACCOUNT? [y/N] " reply </dev/tty || die "Could not read the answer"
    case "$reply" in
        y|Y|yes|YES) ;;
        *) echo "Aborted. Nothing was uploaded."; exit 1 ;;
    esac
fi

aws_ s3 cp "$NEW" "$S3_URI" --only-show-errors || die "Upload failed. The original file is backed up at $BACKUP"

# Verify what is stored now
aws_ s3 cp "$S3_URI" "$VERIFY" --only-show-errors || die "Could not download $S3_URI to verify it. Backup: $BACKUP"
problem=""
if [ "$(names_in "$VERIFY")" != "$EXPECTED_NAMES" ]; then
    problem="the stored file has the weather variables: $(names_in "$VERIFY")"
elif ! cmp -s "$NEW" "$VERIFY"; then
    problem="the stored file differs from the uploaded one"
elif ! cmp -s <(strip_weather "$BACKUP") <(strip_weather "$VERIFY"); then
    problem="lines other than the weather variables changed"
fi
if [ -n "$problem" ]; then
    echo "Verification FAILED: $problem." >&2
    echo "Restore with: aws --profile $PROFILE --region $REGION s3 cp $BACKUP $S3_URI" >&2
    exit 1
fi

echo
echo "Uploaded and verified: $EXPECTED_NAMES (other lines unchanged)."
echo "Backup: $BACKUP"
echo
echo "The API tasks read this file only when they start. Start a new deployment to apply it"
echo "(not run by this script; cluster and service names follow scripts/deploy.sh):"
echo "  aws --profile $PROFILE --region $REGION ecs update-service --cluster TAK-${STACK_NAME}-BaseInfra --service TAK-${STACK_NAME}-CloudTAK --force-new-deployment"
