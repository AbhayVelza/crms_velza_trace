# FAST TRACK (docs/golive/FAST_TRACK.md): run a pushed image on the ECS service velza-prod / app, or restart it.
# Run by Kailash with his own short-lived admin sign-in. No access keys. Agents never run this.
# Works in Windows PowerShell 5.1 and PowerShell 7.
#
# Usage (from the repository root):
#   .\deploy\aws\roll-app.ps1 -Tag 1a2b3c4d5e6f-http      # deploy that image (Terraform: new task definition)
#   .\deploy\aws\roll-app.ps1 -ForceNewDeployment         # same image, fresh tasks (e.g. after RDS rotated the
#                                                          # master password: tasks read it only when they start)
#   add -AwsProfile <name> if you use a named profile
#
# -Tag: checks the image is in ECR, writes app_image_tag into infra/aws/live/prod/terraform.tfvars (the one variables
# file stays the truth; commit that line so the branch matches what runs), runs terraform init + plan, shows the
# plan, applies it only after you type yes, then waits until the service is stable and /api/health is 200.
# If the plan fails or you don't type yes, the previous app_image_tag is put back.
param(
  [string]$Tag = '',
  [switch]$ForceNewDeployment,
  [string]$AwsProfile = ''
)
$ErrorActionPreference = 'Stop'

if (-not $Tag -and -not $ForceNewDeployment) { throw 'Pass -Tag <image tag> or -ForceNewDeployment.' }
if ($Tag -and $ForceNewDeployment) { throw 'Pass either -Tag or -ForceNewDeployment, not both.' }
if ($Tag -and $Tag -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') { throw "Not a valid image tag: $Tag" }

# Native commands run with ErrorActionPreference = Continue (Windows PowerShell 5.1 turns redirected stderr into
# error records, which Stop would throw on); success is judged by the exit code.
function Invoke-Native([string]$what, [scriptblock]$cmd) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $cmd; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $old }
  if ($code -ne 0) { throw "$what failed (exit code $code)" }
}

# Runs a native command quietly (stderr discarded). Returns its trimmed stdout, or $null if it failed.
function Get-NativeOutput([scriptblock]$cmd) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $cmd 2>$null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $old }
  if ($code -ne 0 -or $null -eq $out) { return $null }
  return (($out | Out-String).Trim())
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$root = Join-Path $repoRoot 'infra\aws\live\prod'
$tfvars = Join-Path $root 'terraform.tfvars'
function Get-TfvarsValue([string]$name) {
  $m = Select-String -Path $tfvars -Pattern "^\s*$name\s*=\s*`"([^`"]*)`"" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value } else { return '' }
}

# Read and write terraform.tfvars as UTF-8 without BOM (5.1's Get-Content would read it as ANSI).
$utf8 = New-Object System.Text.UTF8Encoding($false)
$tagPattern = '(?m)^(\s*app_image_tag\s*=\s*)"[^"]*"'
function Set-ImageTag([string]$value) {
  $content = [System.IO.File]::ReadAllText($tfvars, $utf8)
  if ($content -notmatch $tagPattern) { throw "app_image_tag not found in $tfvars" }
  $updated = [regex]::Replace($content, $tagPattern, ('${1}"' + $value + '"'))
  [System.IO.File]::WriteAllText($tfvars, $updated, $utf8)
}

foreach ($tool in 'aws', 'terraform') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed or not on PATH." }
}
if ($AwsProfile) { $env:AWS_PROFILE = $AwsProfile }

$accountId = Get-TfvarsValue 'account_id'
$region = Get-TfvarsValue 'region'
$cluster = 'velza-prod'
$service = 'app'

$caller = Get-NativeOutput { aws sts get-caller-identity --query Account --output text }
if (-not $caller) { throw 'Not signed in to AWS (or the sign-in has expired). Run your admin sign-in first (aws sso login / aws login).' }
if ($caller -ne $accountId) { throw "Signed in to account $caller, but terraform.tfvars says $accountId. Stop." }

if ($Tag) {
  # 1. The image must exist (a task definition pointing at a missing tag would fail to start).
  $count = Get-NativeOutput { aws ecr list-images --region $region --repository-name velza-app --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='$Tag'])" --output text }
  if ($null -eq $count) { throw 'Cannot read ECR repository velza-app. Did the Terraform apply (FAST_TRACK.md step 2) finish?' }
  if ([int]$count -eq 0) { throw "velza-app:$Tag is not in ECR. Run .\deploy\aws\build-push.ps1 first." }

  # 2. Write the tag into the one variables file (the old value is put back unless the plan is applied).
  $previousTag = Get-TfvarsValue 'app_image_tag'
  Set-ImageTag $Tag
  Write-Host "terraform.tfvars: app_image_tag = `"$Tag`" (was `"$previousTag`")"

  # 3. init (backend from tfvars), plan to a file OUTSIDE the repo, show, apply only on "yes".
  $planFile = Join-Path $env:TEMP 'velza-prod-roll.tfplan'
  $applyStarted = $false
  $applied = $false
  try {
    Invoke-Native 'terraform init' { & (Join-Path $repoRoot 'infra\aws\scripts\init.ps1') prod }
    Invoke-Native 'terraform plan' { terraform "-chdir=$root" plan -input=false "-out=$planFile" }
    Write-Host ''
    Write-Host 'Expected: changes only under module.app (task definition replaced, service updated).'
    Write-Host 'First roll: 1 to add, 1 to change, 1 to destroy. Anything else (above all module.data): answer no.'
    $answer = Read-Host 'Apply this plan? Type yes'
    if ($answer -ne 'yes') { Write-Host 'Not applied.'; return }
    $applyStarted = $true
    Invoke-Native 'terraform apply' { terraform "-chdir=$root" apply -input=false $planFile }
    $applied = $true
  }
  finally {
    Remove-Item -Path $planFile -ErrorAction SilentlyContinue
    if (-not $applyStarted) {
      Set-ImageTag $previousTag
      Write-Host "terraform.tfvars: app_image_tag put back to `"$previousTag`"."
    }
    elseif (-not $applied) {
      Write-Host "The apply did not finish: terraform.tfvars keeps `"$Tag`". Run a plan to see what is left."
    }
  }
}
else {
  Invoke-Native 'aws ecs update-service' { aws ecs update-service --region $region --cluster $cluster --service $service --force-new-deployment --query 'service.serviceName' --output text }
}

# 4. Wait until the service is stable (new tasks healthy behind the ALB, old ones drained). Up to ~10 minutes.
Write-Host 'Waiting for the service to become stable (up to 10 minutes) ...'
$old = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { & aws ecs wait services-stable --region $region --cluster $cluster --services $service; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $old }
if ($code -ne 0) {
  throw "Service not stable. Look at: ECS console > $cluster > $service > Deployments/Events, and the log group /velza/prod/app."
}

# 5. Health over the ALB.
$url = Get-NativeOutput { terraform "-chdir=$root" output -raw app_url }
if (-not $url) { throw 'Could not read the app_url output (terraform output -raw app_url).' }
try {
  $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 15
  Write-Host "Health: HTTP $($r.StatusCode) $($r.Content)"
}
catch {
  throw "Health check on $url/api/health failed: $($_.Exception.Message)"
}
Write-Host "Open: $url"
