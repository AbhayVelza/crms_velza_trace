# Phase 2 foundation for velza-staging: GitHub Actions access (and, only if this root owns the account-wide things,
# the state bucket and the ONE account budget + anomaly monitor). In the demo account staging does NOT own them
# (manage_account_resources = false): the prod root does, so the $30/$60/$90 alerts cover the whole account once.

locals {
  env       = "staging"
  state_key = "live/staging/terraform.tfstate" # same as backend.tf
}

module "state" {
  source = "../../modules/state"
  count  = var.manage_account_resources ? 1 : 0

  bucket_name = var.state_bucket
  protect     = var.protect
}

module "budgets" {
  source = "../../modules/budgets"
  count  = var.manage_account_resources ? 1 : 0

  budget_name           = var.budget_name
  thresholds_usd        = var.budget_thresholds_usd
  anomaly_threshold_usd = var.anomaly_threshold_usd
  anomaly_monitor_name  = "velza-account-services"
  alert_email           = var.alert_email
}

module "ci_access" {
  source = "../../modules/ci_access"

  env                       = local.env
  account_id                = var.account_id
  region                    = var.region
  github_repo               = var.github_repo
  github_deploy_environment = "staging"
  state_bucket              = var.state_bucket
  state_key                 = local.state_key
  manages_state_bucket      = var.manage_account_resources
  create_build_role         = true # images are built once, in staging, and promoted to prod
}

# ---- Phase 3 network (docs/GO_LIVE_ARCHITECTURE.md section 3): VPC, 6 subnets over 2 AZs, IGW, route tables,
# S3 gateway endpoint, DB subnet group, security groups. No NAT, no interface endpoints (D2).

module "network" {
  source = "../../modules/network"

  env      = local.env
  vpc_cidr = var.vpc_cidr
  az_ids   = var.az_ids
}

# ---- Adopt what bootstrap made by hand (docs/golive/BOOTSTRAP.md). After the first apply these are no-ops.

import {
  to = module.ci_access.aws_iam_role.tf_apply
  id = "velza-${local.env}-gha-tf-apply"
}

import {
  for_each = var.manage_account_resources ? toset([var.state_bucket]) : toset([])
  to       = module.state[0].aws_s3_bucket.this
  id       = each.value
}
