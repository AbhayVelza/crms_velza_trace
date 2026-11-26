# terraform init for one go-live root, with the backend bucket/region read from that root's terraform.tfvars
# (a backend block cannot read variables, so this keeps terraform.tfvars the single source of truth).
# Usage: .\infra\aws\scripts\init.ps1 staging|prod [extra terraform init args]
param(
  [Parameter(Mandatory = $true)][ValidateSet('staging', 'prod')][string]$Environment,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot "..\live\$Environment")
$tfvars = Join-Path $root 'terraform.tfvars'

function Get-TfvarsValue([string]$name) {
  $m = Select-String -Path $tfvars -Pattern "^\s*$name\s*=\s*`"([^`"]*)`"" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value } else { return '' }
}
$bucket = Get-TfvarsValue 'state_bucket'
$region = Get-TfvarsValue 'region'

if (-not $bucket -or -not $region) { throw "state_bucket or region missing in $tfvars" }
if ($bucket -like '*000000000000*') { throw "Fill in account_id and state_bucket in $tfvars first (placeholder found)." }

& terraform "-chdir=$root" init -input=false "-backend-config=bucket=$bucket" "-backend-config=region=$region" @Rest
exit $LASTEXITCODE
