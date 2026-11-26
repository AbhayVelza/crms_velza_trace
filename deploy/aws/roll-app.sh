#!/usr/bin/env bash
# FAST TRACK (docs/golive/FAST_TRACK.md): run a pushed image on ECS velza-prod / app, or restart it.
# Same as roll-app.ps1, for Linux / macOS / Git Bash. Run with your own short-lived admin sign-in; agents never run it.
# If the plan fails or you don't type yes, the previous app_image_tag is put back in terraform.tfvars.
#
#   deploy/aws/roll-app.sh --tag 1a2b3c4d5e6f-http     # deploy that image (Terraform: new task definition)
#   deploy/aws/roll-app.sh --force-new-deployment      # same image, fresh tasks (e.g. after the master password rotated)
set -euo pipefail

tag=""
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="${2:-}"; shift 2 ;;
    --force-new-deployment) force=1; shift ;;
    *) echo "usage: $0 --tag <image tag> | --force-new-deployment" >&2; exit 2 ;;
  esac
done
if [ -z "$tag" ] && [ "$force" != 1 ]; then echo "Pass --tag <image tag> or --force-new-deployment." >&2; exit 2; fi
if [ -n "$tag" ] && [ "$force" = 1 ]; then echo "Pass either --tag or --force-new-deployment, not both." >&2; exit 2; fi
if [ -n "$tag" ] && ! printf '%s' "$tag" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'; then echo "Not a valid image tag: $tag" >&2; exit 2; fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
root="$repo_root/infra/aws/live/prod"
tfvars="$root/terraform.tfvars"
value() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$tfvars" | head -n 1; }
set_tag() {
  tmp="$(mktemp)"
  sed -E "s/^([[:space:]]*app_image_tag[[:space:]]*=[[:space:]]*)\"[^\"]*\"/\1\"$1\"/" "$tfvars" > "$tmp" && cat "$tmp" > "$tfvars" && rm -f "$tmp"
}

account_id="$(value account_id)"
region="$(value region)"
cluster="velza-prod"
service="app"

caller="$(aws sts get-caller-identity --query Account --output text)" || { echo "Not signed in to AWS (or the sign-in has expired)." >&2; exit 1; }
[ "$caller" = "$account_id" ] || { echo "Signed in to account $caller, but terraform.tfvars says $account_id. Stop." >&2; exit 1; }

if [ -n "$tag" ]; then
  count="$(aws ecr list-images --region "$region" --repository-name velza-app --filter tagStatus=TAGGED \
    --query "length(imageIds[?imageTag=='$tag'])" --output text)" \
    || { echo "Cannot read ECR repository velza-app. Did the Terraform apply finish?" >&2; exit 1; }
  [ "$count" != "0" ] || { echo "velza-app:$tag is not in ECR. Run deploy/aws/build-push.sh first." >&2; exit 1; }

  grep -Eq '^[[:space:]]*app_image_tag[[:space:]]*=' "$tfvars" || { echo "app_image_tag not found in $tfvars" >&2; exit 1; }
  previous="$(value app_image_tag)"
  set_tag "$tag"
  echo "terraform.tfvars: app_image_tag = \"$tag\" (was \"$previous\")"

  # Until the apply starts, any exit (plan failed, answer not yes, Ctrl-C) puts the previous tag back.
  plan="$(mktemp -d)/velza-prod-roll.tfplan"
  state="pending"
  on_exit() {
    rm -f "$plan"
    case "$state" in
      pending) set_tag "$previous"; echo "terraform.tfvars: app_image_tag put back to \"$previous\"." ;;
      applying) echo "The apply did not finish: terraform.tfvars keeps \"$tag\". Run a plan to see what is left." ;;
    esac
  }
  trap on_exit EXIT

  "$repo_root/infra/aws/scripts/init.sh" prod
  terraform -chdir="$root" plan -input=false -out="$plan"
  echo
  echo "Expected: changes only under module.app (task definition replaced, service updated)."
  echo "First roll: 1 to add, 1 to change, 1 to destroy. Anything else (above all module.data): answer no."
  read -r -p "Apply this plan? Type yes: " answer
  if [ "$answer" != "yes" ]; then echo "Not applied."; exit 0; fi
  state="applying"
  terraform -chdir="$root" apply -input=false "$plan"
  state="done"
else
  aws ecs update-service --region "$region" --cluster "$cluster" --service "$service" --force-new-deployment \
    --query 'service.serviceName' --output text
fi

echo "Waiting for the service to become stable (up to 10 minutes) ..."
aws ecs wait services-stable --region "$region" --cluster "$cluster" --services "$service" \
  || { echo "Service not stable: see ECS console > $cluster > $service > Events, and log group /velza/prod/app." >&2; exit 1; }

url="$(terraform -chdir="$root" output -raw app_url)"
echo "Health: $(curl -fsS --max-time 15 "$url/api/health")"
echo "Open: $url"
