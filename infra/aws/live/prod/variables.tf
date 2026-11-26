# Values come ONLY from terraform.tfvars in this folder (the one file that differs between the demo and the company
# account). The validation blocks stop placeholders (000000000000, CHANGE_ME@example.com) from reaching a plan.

variable "account_id" {
  description = "12-digit AWS account ID this root may run against."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id)) && var.account_id != "000000000000"
    error_message = "account_id must be the real 12-digit AWS account ID (not the 000000000000 placeholder)."
  }
}

variable "region" {
  description = "Main AWS region (Mumbai = ap-south-1)."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "region must look like ap-south-1."
  }
}

variable "dr_region" {
  description = "Disaster-recovery region (Hyderabad = ap-south-2), used from Phase 4."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.dr_region)) && var.dr_region != var.region
    error_message = "dr_region must look like ap-south-2 and differ from region."
  }
}

variable "domain" {
  description = "Domain of this environment (used from Phase 5: Route 53, ACM, ALB)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+[.][a-z]{2,}$", var.domain)) && !strcontains(lower(var.domain), "change_me") && !endswith(var.domain, "example.com")
    error_message = "domain must be a real domain name (not a placeholder)."
  }
}

variable "protect" {
  description = "true = deletion protection everywhere (company account). false = terraform destroy removes everything (demo)."
  type        = bool
}

variable "manage_account_resources" {
  description = "true = this root owns the account-wide things: state bucket, the ONE account budget, the anomaly monitor."
  type        = bool
}

variable "budget_name" {
  description = "Name of the account-level monthly budget (only created when manage_account_resources = true)."
  type        = string
}

variable "budget_thresholds_usd" {
  description = "Monthly alert thresholds in USD, tax included; the highest is the budget limit and the forecast alert."
  type        = list(number)

  validation {
    condition     = length(var.budget_thresholds_usd) >= 1 && length(var.budget_thresholds_usd) <= 4 && alltrue([for t in var.budget_thresholds_usd : t > 0])
    error_message = "budget_thresholds_usd needs 1 to 4 positive numbers."
  }
}

variable "anomaly_threshold_usd" {
  description = "Cost Anomaly Detection emails an anomaly when its total cost impact is at least this many USD."
  type        = number
  default     = 5

  validation {
    condition     = var.anomaly_threshold_usd > 0
    error_message = "anomaly_threshold_usd must be positive."
  }
}

variable "alert_email" {
  description = "Email address that receives budget and cost-anomaly alerts."
  type        = string

  validation {
    condition     = can(regex("^[^@ ]+@[^@ ]+[.][a-z]{2,}$", var.alert_email)) && !strcontains(lower(var.alert_email), "change_me") && !endswith(lower(var.alert_email), "@example.com")
    error_message = "alert_email must be a real address (not CHANGE_ME@example.com)."
  }
}

variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to sign in through OIDC."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must be owner/name."
  }
}

variable "state_bucket" {
  description = "Terraform state bucket of this account: velza-tfstate-<account_id>."
  type        = string

  validation {
    condition     = var.state_bucket == "velza-tfstate-${var.account_id}"
    error_message = "state_bucket must be velza-tfstate-<account_id> (same account_id as above)."
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR of this environment, a /16 (docs/GO_LIVE_ARCHITECTURE.md section 3: prod 10.40.0.0/16, staging 10.41.0.0/16)."
  type        = string
}

variable "az_ids" {
  description = "Two Availability Zone IDs (not names) for the subnets, e.g. [\"aps1-az1\", \"aps1-az3\"]."
  type        = list(string)
}

# ---- FAST TRACK: data (Phase 4 subset) and app (Phase 5 subset). docs/golive/FAST_TRACK.md

variable "db_engine_version" {
  description = "PostgreSQL major version for RDS (\"17\", decision D1, proposed)."
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class (prod: db.t4g.large, decision D11)."
  type        = string
}

variable "db_multi_az" {
  description = "Multi-AZ DB instance with one standby (prod: true)."
  type        = bool
}

variable "db_allocated_storage_gib" {
  description = "gp3 storage at creation in GiB (prod: 200)."
  type        = number
}

variable "db_max_allocated_storage_gib" {
  description = "Storage autoscaling ceiling in GiB (prod: 500)."
  type        = number
}

variable "db_backup_retention_days" {
  description = "Automated backup (PITR) retention in days (prod: 14)."
  type        = number
}

variable "app_cpu" {
  description = "App task CPU units (1024 = 1 vCPU, decision D10)."
  type        = number
}

variable "app_memory_mib" {
  description = "App task memory in MiB (2048, decision D10)."
  type        = number
}

variable "app_desired_count" {
  description = "App tasks once an image exists (D10: 2; fast track: 1 until C1/C8)."
  type        = number
}

variable "app_image_tag" {
  description = "velza-app image tag to run (git commit SHA). \"\" = not pushed yet: the service runs 0 tasks."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for /velza/prod/app and the RDS log groups (prod: 30)."
  type        = number
}
