# Phase 2 foundation for velza-prod: GitHub Actions access and, when this root owns the account-wide things
# (manage_account_resources = true; in the demo account it does), the state bucket and the ONE account budget +
# Cost Anomaly monitor. That budget has no env filter: it covers the whole account, staging included.
# Phase 3 network, and the FAST TRACK modules data / registry / app (docs/golive/FAST_TRACK.md). The staging root
# stays at network only.

locals {
  env       = "prod"
  state_key = "live/prod/terraform.tfstate" # same as backend.tf
  app_port  = 3000                          # the app container's port: SG rules, target group and PORT all use this
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

# ---- Phase 3 network (docs/GO_LIVE_ARCHITECTURE.md section 3): VPC, 6 subnets over 2 AZs, IGW, route tables,
# S3 gateway endpoint, DB subnet group, security groups. No NAT, no interface endpoints (D2).

module "network" {
  source = "../../modules/network"

  env      = local.env
  vpc_cidr = var.vpc_cidr
  az_ids   = var.az_ids
  app_port = local.app_port
}

# ---- FAST TRACK (docs/golive/FAST_TRACK.md): the minimum of Phases 4 and 5 to run TODAY's app (schema v10) on the
# go-live shape in the demo account. The modules are the real ones (section 12); later phases extend them.

# Phase 4 subset: RDS PostgreSQL 17 Multi-AZ + parameter group velza-pg17 + RDS log groups.
module "data" {
  source = "../../modules/data"

  env                       = local.env
  protect                   = var.protect
  db_subnet_group_name      = module.network.db_subnet_group_name
  security_group_ids        = [module.network.security_group_ids["db"]]
  engine_version            = var.db_engine_version
  instance_class            = var.db_instance_class
  multi_az                  = var.db_multi_az
  allocated_storage_gib     = var.db_allocated_storage_gib
  max_allocated_storage_gib = var.db_max_allocated_storage_gib
  backup_retention_days     = var.db_backup_retention_days
  log_retention_days        = var.log_retention_days
}

# Phase 5 subset: ECR. In the demo account there is one registry and it lives here (the real design, D6, puts the
# source registry in the staging account and replicates to prod).
module "registry" {
  source = "../../modules/registry"

  repositories = ["velza-app"]
  protect      = var.protect
}

# Phase 5 subset: ALB (HTTP only), ECS cluster, service and task definition, task roles, log group.
module "app" {
  source = "../../modules/app"

  env                      = local.env
  protect                  = var.protect
  permissions_boundary_arn = module.ci_access.boundary_arn
  vpc_id                   = module.network.vpc_id
  public_subnet_ids        = module.network.subnet_ids["public"]
  alb_security_group_id    = module.network.security_group_ids["alb"]
  app_security_group_id    = module.network.security_group_ids["app"]
  repository_url           = module.registry.repository_urls["velza-app"]
  repository_arn           = module.registry.repository_arns["velza-app"]
  container_port           = local.app_port
  image_tag                = var.app_image_tag
  cpu                      = var.app_cpu
  memory_mib               = var.app_memory_mib
  desired_count            = var.app_desired_count
  log_retention_days       = var.log_retention_days

  # FAST-TRACK SHORTCUT (replaced in Phase 4): the app connects as the RDS MASTER user and creates/upgrades the
  # schema itself on first use (C10 not done yet), and seeds AD0001 / HQ0001 on an empty database.
  # DATABASE_URL carries no user or password: node-postgres fills them from PGUSER / PGPASSWORD, which ECS reads from
  # the RDS-managed secret at task start (JSON keys username / password). So no password is in this file, in the
  # task definition or in the Terraform state. TLS: sslmode=verify-full against the RDS CA bundle baked into the image
  # (Dockerfile `certs` stage); the parameter group forces TLS (rds.force_ssl = 1).
  # Phase 4 replaces PGUSER/PGPASSWORD with a velza_app DATABASE_URL SecureString in /velza/prod/ and sets
  # VELZA_SCHEMA_AUTO=off.
  environment = {
    PORT         = tostring(local.app_port) # the image sets PORT=3000 and HOSTNAME=0.0.0.0; stated here so they
    HOSTNAME     = "0.0.0.0"                # can't drift from the SG rules and target group
    STORE        = "postgres"
    DATABASE_URL = "postgres://${module.data.address}:${module.data.port}/${module.data.db_name}?sslmode=verify-full&sslrootcert=/etc/ssl/aws/rds-global-bundle.pem"
    PG_POOL_MAX  = "10"
    SIGN_IN      = "on" # a production build always requires sign-in anyway
    NODE_OPTIONS = "--max-old-space-size=1280"
  }
  secrets = {
    PGUSER     = "${module.data.master_user_secret_arn}:username::"
    PGPASSWORD = "${module.data.master_user_secret_arn}:password::"
  }
  secret_arns = [module.data.master_user_secret_arn]
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
