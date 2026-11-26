# Database for one environment (docs/GO_LIVE_ARCHITECTURE.md sections 4 and 12, docs/DATABASE_GO_LIVE.md section 2).
#
#   RDS PostgreSQL <engine_version> (17, decision D1, proposed), Multi-AZ DB instance (one standby, D9) in the network
#   module's DB subnet group and `db` security group, gp3 with storage autoscaling, not publicly accessible,
#   TLS only (rds.force_ssl), parameter group velza-pg17 (prod) / velza-pg17-staging (staging).
#   Master user postgres_admin, password MANAGED BY RDS in Secrets Manager (D5): Terraform never sees it, so it is
#   not in the state. RDS rotates it every 7 days.
#   Log groups for the RDS logs exported to CloudWatch, made here with a retention so `destroy` removes them too
#   (if RDS made them they would keep logs forever and stay behind).
#
# `protect`: true = deletion protection on and a final snapshot when the instance is deleted, automated backups kept.
#            false (demo) = no deletion protection, no final snapshot, automated backups deleted with the instance,
#            so `terraform destroy` leaves nothing that keeps costing money.
#
# Fast track (docs/golive/FAST_TRACK.md) builds only what TODAY's app needs. Added in Phase 4, by extending this
# module (not replacing it): KMS customer-managed key (D4; the key is chosen at creation, so the v11 database is a
# NEW instance anyway), cross-Region automated backups to Hyderabad (D3, provider aws.dr), S3 photo and backup buckets,
# SSM placeholders for the velza_owner / velza_app / velza_readonly URLs, Enhanced Monitoring (needs an IAM role),
# and the db-bootstrap task design (bootstrap_aws.sql, roles).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "env" {
  description = "Environment name: staging or prod. Used in names (velza-<env>)."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "protect" {
  description = "true = deletion protection + final snapshot + keep automated backups. false (demo) = destroy removes everything."
  type        = bool
}

variable "db_subnet_group_name" {
  description = "DB subnet group from modules/network (velza-<env>-db)."
  type        = string
}

variable "security_group_ids" {
  description = "Security groups of the database (modules/network security_group_ids.db)."
  type        = list(string)
}

variable "engine_version" {
  description = "PostgreSQL major version (\"17\", decision D1). Only the major: RDS picks its default minor; minor upgrades are applied by hand."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{2}$", var.engine_version))
    error_message = "engine_version must be a major version such as 17."
  }
}

variable "instance_class" {
  description = "RDS instance class, e.g. db.t4g.large (prod, D11) or db.t4g.small (staging)."
  type        = string

  validation {
    condition     = startswith(var.instance_class, "db.")
    error_message = "instance_class must look like db.t4g.large."
  }
}

variable "multi_az" {
  description = "true = Multi-AZ DB instance with one synchronous standby (prod). false = Single-AZ (staging)."
  type        = bool
}

variable "allocated_storage_gib" {
  description = "gp3 storage at creation, in GiB (prod 200). Storage grows online but never shrinks."
  type        = number

  validation {
    condition     = var.allocated_storage_gib >= 20
    error_message = "allocated_storage_gib must be at least 20."
  }
}

variable "max_allocated_storage_gib" {
  description = "Storage autoscaling ceiling in GiB (prod 500)."
  type        = number
}

variable "backup_retention_days" {
  description = "Automated backup (PITR) retention in days (prod 14, staging 7)."
  type        = number

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be 1 to 35."
  }
}

variable "db_name" {
  description = "Database created with the instance."
  type        = string
  default     = "velza"
}

variable "master_username" {
  description = "Master user (emergencies and bootstrap only; DATABASE_GO_LIVE.md section 3)."
  type        = string
  default     = "postgres_admin"
}

variable "log_retention_days" {
  description = "Retention of the RDS log groups in CloudWatch Logs."
  type        = number
  default     = 30
}

variable "parameter_overrides" {
  description = "Parameter values that differ from the production set below (staging: max_connections 60, work_mem 8192 ...)."
  type        = map(string)
  default     = {}
}

locals {
  name         = "velza-${var.env}"
  param_family = "postgres${var.engine_version}"
  # DATABASE_GO_LIVE.md section 2: velza-pg17 (prod) and velza-pg17-staging.
  param_group_name = var.env == "prod" ? "velza-pg${var.engine_version}" : "velza-pg${var.engine_version}-staging"

  # DATABASE_GO_LIVE.md section 2, production values. Units are RDS's: kB for *_mem, MB for max_wal_size, s for
  # checkpoint_timeout / autovacuum_naptime, ms for the timeouts and log_min_duration_statement, kB for log_temp_files.
  # shared_buffers / effective_cache_size stay on the RDS formulas.
  parameters = merge({
    "rds.force_ssl"                       = "1"
    "shared_preload_libraries"            = "pg_stat_statements"
    "pg_stat_statements.track"            = "top"
    "track_io_timing"                     = "1"
    "max_connections"                     = "150"
    "work_mem"                            = "16384"  # 16MB
    "maintenance_work_mem"                = "524288" # 512MB
    "autovacuum_work_mem"                 = "262144" # 256MB
    "autovacuum_max_workers"              = "4"
    "autovacuum_vacuum_cost_limit"        = "2000"
    "autovacuum_naptime"                  = "30"
    "random_page_cost"                    = "1.1"
    "effective_io_concurrency"            = "200"
    "wal_compression"                     = "lz4" # check before the first apply: docs/golive/FAST_TRACK.md step 1
    "max_wal_size"                        = "4096"
    "checkpoint_timeout"                  = "900"
    "log_min_duration_statement"          = "500"
    "log_lock_waits"                      = "1"
    "log_autovacuum_min_duration"         = "10000"
    "log_temp_files"                      = "10240"
    "log_connections"                     = "1"
    "log_disconnections"                  = "1"
    "idle_in_transaction_session_timeout" = "300000"
    "timezone"                            = "UTC"
  }, var.parameter_overrides)
}

# ---------------------------------------------------------------- parameter group

resource "aws_db_parameter_group" "this" {
  name        = local.param_group_name
  family      = local.param_family
  description = "velza-${var.env} PostgreSQL ${var.engine_version} settings (docs/DATABASE_GO_LIVE.md section 2)."

  dynamic "parameter" {
    for_each = local.parameters
    content {
      name  = parameter.key
      value = parameter.value
      # pending-reboot for every parameter: RDS accepts it for dynamic and static parameters alike, a NEW instance
      # starts with all of them, and a later change never hits a running database mid-shift; it waits for the next
      # reboot (in the Monday 01:30-02:00 IST maintenance window, or by hand).
      apply_method = "pending-reboot"
    }
  }

  tags = { Name = local.param_group_name }
}

# ---------------------------------------------------------------- log groups for the exported RDS logs

# trivy AVD-AWS-0017 accepted: AWS-owned encryption for now; the KMS CMK (D4) arrives in Phase 4.
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "rds" {
  for_each = toset(["postgresql", "upgrade"])

  name              = "/aws/rds/instance/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------- the instance

# trivy AVD-AWS-0176 accepted: IAM database authentication is off by design (architecture section 4); logins use
#   passwords from Secrets Manager / Parameter Store.
# trivy AVD-AWS-0177 accepted: deletion protection follows `protect` (true in the company account, false in the demo).
# trivy AVD-AWS-0078 / AVD-AWS-0079 accepted: AWS-managed keys until the KMS CMK (D4) arrives in Phase 4.
#trivy:ignore:AVD-AWS-0176
#trivy:ignore:AVD-AWS-0177
#trivy:ignore:AVD-AWS-0078
#trivy:ignore:AVD-AWS-0079
resource "aws_db_instance" "this" {
  identifier = local.name

  engine                     = "postgres"
  engine_version             = var.engine_version
  auto_minor_version_upgrade = false # minor upgrades by hand in the maintenance window (DATABASE_GO_LIVE.md section 2)
  instance_class             = var.instance_class
  multi_az                   = var.multi_az
  parameter_group_name       = aws_db_parameter_group.this.name

  storage_type          = "gp3" # < 400 GiB: 3,000 IOPS / 125 MiB/s baseline, cannot be raised
  allocated_storage     = var.allocated_storage_gib
  max_allocated_storage = var.max_allocated_storage_gib
  storage_encrypted     = true # AWS-managed key aws/rds for now; CMK (D4) in Phase 4

  db_name                     = var.db_name
  username                    = var.master_username
  manage_master_user_password = true # RDS keeps the password in Secrets Manager; never in Terraform state (D5)

  db_subnet_group_name   = var.db_subnet_group_name
  vpc_security_group_ids = var.security_group_ids
  publicly_accessible    = false
  port                   = 5432

  backup_retention_period = var.backup_retention_days
  backup_window           = "19:00-19:30"         # 00:30-01:00 IST
  maintenance_window      = "sun:20:00-sun:20:30" # Mon 01:30-02:00 IST
  copy_tags_to_snapshot   = true

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  # Performance Insights API, 7 days = free tier (shown in CloudWatch Database Insights, standard mode).
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  iam_database_authentication_enabled = false

  deletion_protection       = var.protect
  skip_final_snapshot       = !var.protect
  final_snapshot_identifier = var.protect ? "${local.name}-final" : null
  delete_automated_backups  = !var.protect

  tags = { Name = local.name }

  depends_on = [aws_cloudwatch_log_group.rds]
}

# ---------------------------------------------------------------- outputs (app module, later phases)

output "db_instance_id" {
  value = aws_db_instance.this.identifier
}

output "db_instance_arn" {
  value = aws_db_instance.this.arn
}

output "address" {
  description = "Host name of the primary (it follows a Multi-AZ failover)."
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "db_name" {
  value = aws_db_instance.this.db_name
}

output "master_username" {
  value = aws_db_instance.this.username
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed Secrets Manager secret (JSON keys: username, password). The VALUE is never in the state."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "parameter_group_name" {
  value = aws_db_parameter_group.this.name
}
