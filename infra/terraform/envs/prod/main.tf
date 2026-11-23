# Production: 2 vCPU / 4 GB server, Lightsail managed PostgreSQL 16 (4 GB, 120 GB), 100 GB backup bucket.
# Sizes follow the Cloud Infrastructure & Cost Plan (launch stage, about US$87/month for these resources).

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.80, < 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "velza-terraform-state"
    key          = "prod/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-south-1"
}

variable "deploy_ssh_public_key" {
  description = "Public key for the production deploy key (a different key from staging)."
  type        = string
}

module "env" {
  source = "../../modules/velza_env"

  env                   = "prod"
  domain                = "app.velzaglobal.com"
  acme_email            = "ops@velzaglobal.com" # change to the team's address
  instance_bundle_id    = "medium_3_0"          # 2 vCPU / 4 GB, US$24
  create_database       = true
  database_bundle_id    = "medium_2_0" # 4 GB / 120 GB, US$60. High availability: "medium_ha_2_0" (US$120)
  bucket_bundle_id      = "medium_1_0" # 100 GB, US$3
  deploy_ssh_public_key = var.deploy_ssh_public_key
}

output "static_ip" { value = module.env.static_ip }
output "database_endpoint" { value = module.env.database_endpoint }
output "backup_bucket" { value = module.env.backup_bucket }
output "parameter_path" { value = module.env.parameter_path }
