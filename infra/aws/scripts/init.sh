#!/usr/bin/env sh
# terraform init for one go-live root, with the backend bucket/region read from that root's terraform.tfvars
# (a backend block cannot read variables, so this keeps terraform.tfvars the single source of truth).
# Usage: infra/aws/scripts/init.sh staging|prod [extra terraform init args]
set -eu
env="${1:-}"
case "$env" in staging|prod) ;; *) echo "usage: $0 staging|prod [init args]" >&2; exit 2 ;; esac
shift
root="$(cd "$(dirname "$0")/../live/$env" && pwd)"
tfvars="$root/terraform.tfvars"

value() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$tfvars" | head -n 1; }
bucket="$(value state_bucket)"
region="$(value region)"

if [ -z "$bucket" ] || [ -z "$region" ]; then
  echo "state_bucket or region missing in $tfvars" >&2; exit 1
fi
case "$bucket" in *000000000000*) echo "Fill in account_id and state_bucket in $tfvars first (placeholder found)." >&2; exit 1 ;; esac

exec terraform -chdir="$root" init -input=false \
  -backend-config="bucket=$bucket" \
  -backend-config="region=$region" "$@"
