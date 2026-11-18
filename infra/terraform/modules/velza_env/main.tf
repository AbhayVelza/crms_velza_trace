# One Velza environment on AWS Lightsail: server + static IP + firewall, managed PostgreSQL (prod) or a database
# container (staging), a backup bucket, and every runtime setting in Parameter Store under /velza/<env>/.
# The deploy workflow turns those parameters into the server's .env (docs/DEPLOYMENT.md).

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.80, < 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

locals {
  name      = "velza-${var.env}"
  param     = "/velza/${var.env}"
  tags      = merge({ project = "velza", env = var.env, managed_by = "terraform" }, var.tags)
  ssl_query = "sslmode=verify-full&sslrootcert=/etc/ssl/aws/rds-global-bundle.pem"
}

# ---------------------------------------------------------------- server

resource "aws_lightsail_key_pair" "deploy" {
  name       = "${local.name}-deploy"
  public_key = var.deploy_ssh_public_key
  tags       = local.tags
}

resource "aws_lightsail_instance" "app" {
  name              = "${local.name}-app"
  availability_zone = var.availability_zone
  blueprint_id      = var.instance_blueprint_id
  bundle_id         = var.instance_bundle_id
  key_pair_name     = aws_lightsail_key_pair.deploy.name
  user_data         = file("${path.module}/user_data.sh")
  tags              = local.tags

  lifecycle {
    # Changing the first-boot script must not replace a running server.
    ignore_changes = [user_data]
  }
}

resource "aws_lightsail_static_ip" "app" {
  name = "${local.name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "app" {
  static_ip_name = aws_lightsail_static_ip.app.name
  instance_name  = aws_lightsail_instance.app.name
}

# The whole firewall: anything not listed is closed.
resource "aws_lightsail_instance_public_ports" "app" {
  instance_name = aws_lightsail_instance.app.name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = ["0.0.0.0/0"]
  }
  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
    cidrs     = ["0.0.0.0/0"]
  }
  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.ssh_allowed_cidrs
  }
}

# ---------------------------------------------------------------- database passwords

# Lightsail master passwords may not contain / " @ or spaces; only - _ . are used so the value is also safe
# unquoted in a .env file and in a URL.
resource "random_password" "db_master" {
  length           = 32
  special          = true
  override_special = "-_."
}

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "random_password" "db_readonly" {
  length  = 32
  special = false
}

resource "random_password" "velza_admin" {
  length  = 20
  special = false
}

resource "random_password" "velza_hq" {
  length  = 20
  special = false
}

# ---------------------------------------------------------------- managed database (prod)

resource "aws_lightsail_database" "main" {
  count = var.create_database ? 1 : 0

  relational_database_name     = "${local.name}-db"
  availability_zone            = var.availability_zone
  blueprint_id                 = var.database_blueprint_id
  bundle_id                    = var.database_bundle_id
  master_database_name         = "velza"
  master_username              = "velza_owner"
  master_password              = random_password.db_master.result
  publicly_accessible          = false
  backup_retention_enabled     = true
  preferred_backup_window      = "19:00-19:30"         # UTC = 00:30-01:00 IST
  preferred_maintenance_window = "Sun:19:30-Sun:20:00" # UTC = Monday 01:00-01:30 IST
  apply_immediately            = true
  skip_final_snapshot          = false
  final_snapshot_name          = "${local.name}-db-final"
  tags                         = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  # Managed: Lightsail endpoint over verified TLS. Staging: the `db` container on the server's private network.
  db_host = var.create_database ? aws_lightsail_database.main[0].master_endpoint_address : "db"
  db_port = var.create_database ? aws_lightsail_database.main[0].master_endpoint_port : 5432
  db_tls  = var.create_database ? "?${local.ssl_query}" : ""
  owner   = var.create_database ? "velza_owner" : "velza"

  migrate_url  = "postgres://${local.owner}:${urlencode(random_password.db_master.result)}@${local.db_host}:${local.db_port}/velza${local.db_tls}"
  app_url      = "postgres://velza_app:${random_password.db_app.result}@${local.db_host}:${local.db_port}/velza${local.db_tls}"
  readonly_url = "postgres://velza_readonly:${random_password.db_readonly.result}@${local.db_host}:${local.db_port}/velza${local.db_tls}"
}

# ---------------------------------------------------------------- backup bucket

resource "aws_lightsail_bucket" "backups" {
  # Bucket names are global across AWS; the account ID keeps this one unique.
  name      = "${local.name}-backups-${data.aws_caller_identity.current.account_id}"
  bundle_id = var.bucket_bundle_id
  tags      = local.tags
}

resource "aws_lightsail_bucket_access_key" "backups" {
  bucket_name = aws_lightsail_bucket.backups.name
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------- runtime settings (Parameter Store)
# Every key below becomes a line of the server's .env (KEY=value). SecureString for anything secret.

locals {
  settings = merge(
    {
      NODE_ENV              = { value = "production", secret = false }
      DOMAIN                = { value = var.domain, secret = false }
      ACME_EMAIL            = { value = var.acme_email, secret = false }
      CLIENT_IP_HEADER      = { value = var.client_ip_header, secret = false }
      PG_POOL_MAX           = { value = tostring(var.pg_pool_max), secret = false }
      DATABASE_URL          = { value = local.app_url, secret = true }
      MIGRATE_DATABASE_URL  = { value = local.migrate_url, secret = true }
      BACKUP_DATABASE_URL   = { value = local.readonly_url, secret = true }
      APP_DB_PASSWORD       = { value = random_password.db_app.result, secret = true }
      READONLY_DB_PASSWORD  = { value = random_password.db_readonly.result, secret = true }
      VELZA_ADMIN_PASSWORD  = { value = random_password.velza_admin.result, secret = true }
      VELZA_HQ_PASSWORD     = { value = random_password.velza_hq.result, secret = true }
      BACKUP_BUCKET         = { value = aws_lightsail_bucket.backups.name, secret = false }
      AWS_DEFAULT_REGION    = { value = var.region, secret = false }
      AWS_ACCESS_KEY_ID     = { value = aws_lightsail_bucket_access_key.backups.access_key_id, secret = true }
      AWS_SECRET_ACCESS_KEY = { value = aws_lightsail_bucket_access_key.backups.secret_access_key, secret = true }
      COMPOSE_PROFILES      = { value = var.create_database ? "" : "localdb", secret = false }
      DEPLOY_HOST           = { value = aws_lightsail_static_ip.app.ip_address, secret = false }
    },
    var.create_database ? {} : {
      LOCAL_DB_PASSWORD = { value = random_password.db_master.result, secret = true }
    },
  )
}

resource "aws_ssm_parameter" "setting" {
  for_each = local.settings

  name  = "${local.param}/${each.key}"
  type  = each.value.secret ? "SecureString" : "String"
  value = each.value.value == "" ? "-" : each.value.value
  tags  = local.tags
}

# Optional heartbeat URLs (Better Stack / healthchecks.io): created empty, filled in by hand, never overwritten.
resource "aws_ssm_parameter" "heartbeat" {
  for_each = toset(["HEARTBEAT_BACKUP_URL", "HEARTBEAT_STOCK_CHECK_URL"])

  name  = "${local.param}/${each.key}"
  type  = "String"
  value = "-"
  tags  = local.tags

  lifecycle {
    ignore_changes = [value]
  }
}
