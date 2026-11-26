# Phase 2 foundation for velza-prod: GitHub Actions access and, when this root owns the account-wide things
# (manage_account_resources = true; in the demo account it does), the state bucket and the ONE account budget +
# Cost Anomaly monitor. That budget has no env filter: it covers the whole account, staging included.

locals {
  env       = "prod"
  state_key = "live/prod/terraform.tfstate" # same as backend.tf
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
  github_deploy_environment = "production" # GitHub environment name, docs/RELEASE_PIPELINE.md
  state_bucket              = var.state_bucket
  state_key                 = local.state_key
  manages_state_bucket      = var.manage_account_resources
  create_build_role         = false # velza-gha-build lives in the staging root
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
