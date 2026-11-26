provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id] # refuses to run against any other account

  default_tags {
    tags = {
      project    = "velza"
      env        = "prod"
      managed_by = "terraform"
    }
  }
}

# Disaster-recovery region (Hyderabad), used from Phase 4 for cross-Region RDS backups and the DR KMS key.
provider "aws" {
  alias               = "dr"
  region              = var.dr_region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      project    = "velza"
      env        = "prod"
      managed_by = "terraform"
    }
  }
}
