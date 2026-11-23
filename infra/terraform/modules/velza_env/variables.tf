variable "env" {
  description = "Environment name: staging or prod. Used in every resource name and the Parameter Store path."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "region" {
  description = "AWS region. Mumbai, for latency to the plant and partners."
  type        = string
  default     = "ap-south-1"
}

variable "availability_zone" {
  description = "Zone for the server and the database (same zone keeps them close)."
  type        = string
  default     = "ap-south-1a"
}

variable "domain" {
  description = "Public hostname served by Caddy, e.g. app.velzaglobal.com. Its DNS A record must point at the static IP output."
  type        = string
}

variable "acme_email" {
  description = "Email Let's Encrypt uses for certificate expiry notices."
  type        = string
}

# Bundle and blueprint IDs: confirm in Mumbai before the first apply (they change with new generations):
#   aws lightsail get-bundles --region ap-south-1
#   aws lightsail get-relational-database-bundles --region ap-south-1
#   aws lightsail get-relational-database-blueprints --region ap-south-1
#   aws lightsail get-bucket-bundles --region ap-south-1
variable "instance_bundle_id" {
  description = "Server size. medium_3_0 = 2 vCPU / 4 GB (US$24); small_3_0 = 2 GB (US$12)."
  type        = string
}

variable "instance_blueprint_id" {
  description = "Server OS."
  type        = string
  default     = "ubuntu_24_04"
}

variable "create_database" {
  description = "true = Lightsail managed PostgreSQL (prod). false = PostgreSQL in a container on the server (staging)."
  type        = bool
}

variable "database_bundle_id" {
  description = "Managed database size. medium_2_0 = 4 GB / 120 GB (US$60); medium_ha_2_0 = the same with a standby (US$120)."
  type        = string
  default     = "medium_2_0"
}

variable "database_blueprint_id" {
  description = "Managed database engine. Lightsail offers PostgreSQL 12-16."
  type        = string
  default     = "postgres_16"
}

variable "bucket_bundle_id" {
  description = "Backup bucket size. medium_1_0 = 100 GB (US$3); large_1_0 = 250 GB (US$5)."
  type        = string
  default     = "medium_1_0"
}

variable "deploy_ssh_public_key" {
  description = "Public half of the key GitHub Actions uses to SSH in as `ubuntu` (the private half is the DEPLOY_SSH_KEY secret)."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = <<-EOT
    Who may reach SSH (22). Deploys SSH in from GitHub-hosted runners, whose addresses change, so the default is
    everyone: login is by key only (Lightsail's Ubuntu image disables passwords) and fail2ban bans brute force.
    To narrow it, deploy from a self-hosted runner with a fixed address and list only that and your office/VPN.
  EOT
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "client_ip_header" {
  description = "Header carrying the real client address: x-real-ip (Caddy) or cf-connecting-ip (Cloudflare proxy in front)."
  type        = string
  default     = "x-real-ip"
}

variable "pg_pool_max" {
  description = "Database connections per app process. Keep well under the database plan's limit."
  type        = number
  default     = 20
}

variable "tags" {
  description = "Extra tags on every resource."
  type        = map(string)
  default     = {}
}
