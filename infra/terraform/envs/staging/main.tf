# Staging: the smallest server, PostgreSQL in a container on it (no managed database), its own bucket and settings.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.80, < 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "velza-terraform-state"
    key          = "staging/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-south-1"
}

variable "deploy_ssh_public_key" {
  description = "Public key for the staging deploy key (see docs/DEPLOYMENT.md, one-time setup)."
  type        = string
}

module "env" {
  source = "../../modules/velza_env"

  env                   = "staging"
  domain                = "staging.velzaglobal.com"
  acme_email            = "ops@velzaglobal.com" # change to the team's address
  instance_bundle_id    = "small_3_0"           # 2 vCPU / 2 GB, US$12
  create_database       = false
  bucket_bundle_id      = "small_1_0" # 5 GB, US$1: staging backups are only for testing the backup itself
  deploy_ssh_public_key = var.deploy_ssh_public_key
}

output "static_ip" { value = module.env.static_ip }
output "backup_bucket" { value = module.env.backup_bucket }
output "parameter_path" { value = module.env.parameter_path }
