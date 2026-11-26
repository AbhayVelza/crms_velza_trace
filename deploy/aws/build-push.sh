#!/usr/bin/env bash
# FAST TRACK (docs/golive/FAST_TRACK.md): build the app image from the current commit and push it to ECR velza-app.
# Same as build-push.ps1, for Linux / macOS / Git Bash. Run with your own short-lived admin sign-in; no access keys.
#
#   deploy/aws/build-push.sh                 # tag <12-char SHA>-http, HTTPS_ONLY=0 (plain-HTTP ALB, fast track)
#   deploy/aws/build-push.sh --https-only    # tag <12-char SHA>, HTTPS_ONLY=1 (from Phase 5, with a domain)
#   AWS_PROFILE=velza-demo deploy/aws/build-push.sh
#
# HTTPS_ONLY is baked in at build time (next.config.ts); with 1 the CSP says upgrade-insecure-requests and the app
# cannot load over http://. See build-push.ps1 for the full explanation.
set -euo pipefail

https_only=0
allow_dirty=0
for a in "$@"; do
  case "$a" in
    --https-only) https_only=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    *) echo "usage: $0 [--https-only] [--allow-dirty]" >&2; exit 2 ;;
  esac
done

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tfvars="$repo_root/infra/aws/live/prod/terraform.tfvars"
value() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$tfvars" | head -n 1; }

for tool in git docker aws; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed or not on PATH (docs/golive/FAST_TRACK.md, step 3)" >&2; exit 1; }
done

account_id="$(value account_id)"
region="$(value region)"
[ -n "$account_id" ] && [ -n "$region" ] || { echo "account_id or region missing in $tfvars" >&2; exit 1; }

caller="$(aws sts get-caller-identity --query Account --output text)" || { echo "Not signed in to AWS (aws sso login / aws login)." >&2; exit 1; }
[ "$caller" = "$account_id" ] || { echo "Signed in to account $caller, but terraform.tfvars says $account_id. Stop." >&2; exit 1; }

cd "$repo_root"
dirty="$(git status --porcelain -- . ':!infra' ':!docs')"
if [ -n "$dirty" ] && [ "$allow_dirty" != 1 ]; then
  printf 'Uncommitted changes outside infra/ and docs/ (the image would not match its tag):\n%s\nCommit or stash, or pass --allow-dirty.\n' "$dirty" >&2
  exit 1
fi
sha="$(git rev-parse --short=12 HEAD)"
if [ "$https_only" = 1 ]; then tag="$sha"; else tag="$sha-http"; fi
[ -z "$dirty" ] || tag="$tag-dirty-$(date -u +%Y%m%d%H%M%S)"

registry="$account_id.dkr.ecr.$region.amazonaws.com"
image="$registry/velza-app:$tag"

count="$(aws ecr list-images --region "$region" --repository-name velza-app --filter tagStatus=TAGGED \
  --query "length(imageIds[?imageTag=='$tag'])" --output text)" \
  || { echo "Cannot read ECR repository velza-app. Did the Terraform apply (FAST_TRACK.md step 2) finish?" >&2; exit 1; }
if [ "$count" != "0" ]; then
  echo "velza-app:$tag is already in ECR (tags are immutable). Nothing to build."
  echo "Next: deploy/aws/roll-app.sh --tag $tag"
  exit 0
fi

echo "Building $image (HTTPS_ONLY=$https_only) ..."
docker build --platform linux/amd64 --target app --build-arg "HTTPS_ONLY=$https_only" -t "$image" .

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT
docker push "$image"

echo
echo "Pushed velza-app:$tag"
echo "Next: deploy/aws/roll-app.sh --tag $tag"
