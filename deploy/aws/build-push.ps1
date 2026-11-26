# FAST TRACK (docs/golive/FAST_TRACK.md): build the app image from the current commit and push it to ECR velza-app.
# Run by Kailash with his own short-lived admin sign-in (aws sso login / aws login). No access keys.
# Works in Windows PowerShell 5.1 and PowerShell 7.
#
# Usage (from the repository root):
#   .\deploy\aws\build-push.ps1                     # tag <12-char SHA>-http, built with HTTPS_ONLY=0 (ALB over HTTP)
#   .\deploy\aws\build-push.ps1 -HttpsOnly          # tag <12-char SHA>, HTTPS_ONLY=1 (from Phase 5, with a domain)
#   .\deploy\aws\build-push.ps1 -AwsProfile velza-demo
#
# Why "-http": HTTPS_ONLY is baked into the image at build time (next.config.ts). With HTTPS_ONLY=1 the pages send
# `Content-Security-Policy: upgrade-insecure-requests`, so a browser on http:// would fetch every script and API call
# over https:// and the app would not load on the plain-HTTP ALB. The -http tag makes such an image easy to spot;
# it is never the image for a real HTTPS environment.
#
# Needs: git, Docker Desktop (running), AWS CLI v2. Prints the tag; then run .\deploy\aws\roll-app.ps1 -Tag <tag>.
param(
  [switch]$HttpsOnly,
  [string]$AwsProfile = '',
  [switch]$AllowDirty
)
$ErrorActionPreference = 'Stop'

# Native commands (aws, docker, git) are run with ErrorActionPreference = Continue: in Windows PowerShell 5.1 a native
# program's stderr, once redirected, becomes an error record, and with Stop that throws even when the program
# succeeded. Success is judged by the exit code instead.
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
$tfvars = Join-Path $repoRoot 'infra\aws\live\prod\terraform.tfvars'
function Get-TfvarsValue([string]$name) {
  $m = Select-String -Path $tfvars -Pattern "^\s*$name\s*=\s*`"([^`"]*)`"" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value } else { return '' }
}

foreach ($tool in 'git', 'docker', 'aws') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is not installed or not on PATH. See docs/golive/FAST_TRACK.md, step 3."
  }
}
if ($AwsProfile) { $env:AWS_PROFILE = $AwsProfile }

$accountId = Get-TfvarsValue 'account_id'
$region = Get-TfvarsValue 'region'
if (-not $accountId -or -not $region) { throw "account_id or region missing in $tfvars" }

# 1. Signed in to the right account?
$caller = Get-NativeOutput { aws sts get-caller-identity --query Account --output text }
if (-not $caller) { throw 'Not signed in to AWS (or the sign-in has expired). Run your admin sign-in first (aws sso login / aws login).' }
if ($caller -ne $accountId) { throw "Signed in to account $caller, but terraform.tfvars says $accountId. Stop." }

# 2. The image must match a commit: refuse uncommitted app changes (infra/ and docs/ don't go into the image).
Push-Location $repoRoot
try {
  $dirty = Get-NativeOutput { git status --porcelain -- . ':!infra' ':!docs' }
  if ($dirty -and -not $AllowDirty) {
    throw "Uncommitted changes outside infra/ and docs/ (the image would not match its commit tag):`n$dirty`nCommit or stash them, or pass -AllowDirty for a throw-away test image."
  }
  $sha = Get-NativeOutput { git rev-parse --short=12 HEAD }
  if (-not $sha) { throw 'git rev-parse failed' }
  $httpsArg = if ($HttpsOnly) { '1' } else { '0' }
  $tag = if ($HttpsOnly) { $sha } else { "$sha-http" }
  if ($dirty) { $tag = "$tag-dirty-$(Get-Date -Format 'yyyyMMddHHmmss')" }

  $registry = "$accountId.dkr.ecr.$region.amazonaws.com"
  $image = "$registry/velza-app:$tag"

  # 3. Tags are immutable in ECR: if this tag is there already, nothing to do. (list-images + a count, so a missing
  #    tag is a normal "0", not an error on stderr.)
  $count = Get-NativeOutput { aws ecr list-images --region $region --repository-name velza-app --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='$tag'])" --output text }
  if ($null -eq $count) { throw 'Cannot read ECR repository velza-app. Did the Terraform apply (FAST_TRACK.md step 2) finish?' }
  if ([int]$count -gt 0) {
    Write-Host "velza-app:$tag is already in ECR (tags are immutable). Nothing to build."
    Write-Host "Next: .\deploy\aws\roll-app.ps1 -Tag $tag"
    return
  }

  # 4. Build the `app` target for Fargate (linux/amd64).
  Write-Host "Building $image (HTTPS_ONLY=$httpsArg) ..."
  Invoke-Native 'docker build' { docker build --platform linux/amd64 --target app --build-arg "HTTPS_ONLY=$httpsArg" -t $image . }

  # 5. Log in to ECR with a 12-hour token from your sign-in, push, log out again.
  Invoke-Native 'ECR login' { aws ecr get-login-password --region $region | docker login --username AWS --password-stdin $registry }
  try {
    Invoke-Native 'docker push' { docker push $image }
  }
  finally {
    [void](Get-NativeOutput { docker logout $registry })
  }

  Write-Host ''
  Write-Host "Pushed velza-app:$tag"
  Write-Host "Next: .\deploy\aws\roll-app.ps1 -Tag $tag"
}
finally {
  Pop-Location
}
