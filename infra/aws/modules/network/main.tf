# Phase 3 network for one environment (docs/GO_LIVE_ARCHITECTURE.md section 3, decision D2).
#
#   VPC <vpc_cidr> (a /16) over 2 AZs, pinned by AZ ID (names like ap-south-1a map to different physical zones in
#   different accounts; IDs like aps1-az1 do not, so the demo and the company account land in the same zones).
#
#   tier         AZ 1      AZ 2      route table                                   holds
#   public       x.0/24    x.1/24    0.0.0.0/0 -> IGW, S3 gateway endpoint          ALB, app tasks, one-off tasks
#   (no subnet ever auto-assigns a public IP: D2's task public IP is assign_public_ip = true on the ECS service and
#   run-task in Phase 5; an internet-facing ALB gets its public IPs anyway)
#   private-app  x.10/24   x.11/24   local only, S3 gateway endpoint (RESERVED)     nothing (private option of D2)
#   db           x.20/24   x.21/24   local only, NO internet route, no endpoint     RDS primary + standby
#
#   No NAT gateway, no interface endpoints (D2). The S3 gateway endpoint is free.
#
# Security groups (all rules are separate resources; no inline rules, so nothing fights over them):
#   alb   in 443 + 80 from 0.0.0.0/0 (80 only for the 80->443 redirect)   out 3000 to app
#   app   in 3000 from alb                                                 out 5432 to db, 443 to 0.0.0.0/0
#   task  in none                                                          out 5432 to db, 443 to 0.0.0.0/0
#   db    in 5432 from app and task                                        out none (stateful: replies still flow)
#   The VPC's default security group is adopted and emptied, so nothing can use it by accident.
#
# Also the DB subnet group velza-<env>-db over the two db subnets (pure network, free); Phase 4 (modules/data)
# only references it by name.
#
# Nothing here differs between environments or accounts except var.vpc_cidr and var.az_ids, which come from each
# root's terraform.tfvars. The env tag comes from the provider's default_tags.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "env" {
  description = "Environment name: staging or prod. Used only in names (velza-<env>-*)."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR, a /16 (prod 10.40.0.0/16, staging 10.41.0.0/16). Subnets are fixed /24s inside it."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && try(split("/", var.vpc_cidr)[1] == "16", false) && try(cidrhost(var.vpc_cidr, 0) == split("/", var.vpc_cidr)[0], false)
    error_message = "vpc_cidr must be a /16 network address such as 10.40.0.0/16."
  }
}

variable "az_ids" {
  description = "Exactly two Availability Zone IDs (not names), e.g. [\"aps1-az1\", \"aps1-az3\"]. Index 0 = AZ 1, index 1 = AZ 2."
  type        = list(string)

  validation {
    condition     = length(var.az_ids) == 2 && length(distinct(var.az_ids)) == 2 && alltrue([for z in var.az_ids : can(regex("^[a-z0-9]+-az[0-9]+$", z))])
    error_message = "az_ids must be two different AZ IDs such as aps1-az1 and aps1-az3 (IDs, not names like ap-south-1a)."
  }
}

variable "app_port" {
  description = "Port the app container listens on (Next.js standalone server)."
  type        = number
  default     = 3000
}

variable "db_port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}

data "aws_region" "current" {}

locals {
  name = "velza-${var.env}"

  # tier -> one /24 per AZ, as cidrsubnet(vpc_cidr, 8, netnum): x.0, x.1 / x.10, x.11 / x.20, x.21
  subnet_netnums = {
    public      = [0, 1]
    private-app = [10, 11]
    db          = [20, 21]
  }

  subnets = merge([
    for tier, nums in local.subnet_netnums : {
      for i, n in nums : "${tier}-${i}" => {
        tier  = tier
        az_id = var.az_ids[i]
        cidr  = cidrsubnet(var.vpc_cidr, 8, n)
        name  = "${local.name}-${tier}-${var.az_ids[i]}"
      }
    }
  ]...)

  tiers = keys(local.subnet_netnums)
}

# ---------------------------------------------------------------- VPC and internet gateway

# trivy AVD-AWS-0178 accepted: flow logs not in the approved design; GuardDuty uses its own flow feed; revisit in Phase 7.
#trivy:ignore:AVD-AWS-0178
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # RDS endpoint names and (if D2 changes) interface endpoint private DNS need both

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = local.name }
}

# ---------------------------------------------------------------- subnets

resource "aws_subnet" "this" {
  for_each = local.subnets

  vpc_id               = aws_vpc.this.id
  cidr_block           = each.value.cidr
  availability_zone_id = each.value.az_id
  # false everywhere, public tier included. Fargate takes its public IP only from assign_public_ip = true on the
  # ECS service / run-task (Phase 5, decision D2) and an internet-facing ALB gets public IPs anyway, so this flag
  # would only hand public IPs to stray EC2 instances or ENIs.
  map_public_ip_on_launch = false

  tags = {
    Name = each.value.name
    tier = each.value.tier
  }
}

# ---------------------------------------------------------------- route tables

resource "aws_route_table" "this" {
  for_each = toset(local.tiers)

  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name}-${each.key}"
    tier = each.key
  }
}

# Only the public table gets a default route. private-app and db keep the implicit local route only.
resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.this["public"].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "this" {
  for_each = local.subnets

  subnet_id      = aws_subnet.this[each.key].id
  route_table_id = aws_route_table.this[each.value.tier].id
}

# ---------------------------------------------------------------- S3 gateway endpoint (free)
# On the public table (photos, backups and ECR image layers stay on the AWS network) and on the reserved private-app
# table (harmless while empty, ready for the private option). NOT on the db table: the database tier gets no path
# out of the VPC at all; the db SG has no egress either, and RDS's own backups do not use the VPC's routes.
# Default (full-access) endpoint policy on purpose: ECR layer downloads go through this endpoint to an AWS-owned
# bucket, so a policy limited to our own buckets would break image pulls.

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.this["public"].id, aws_route_table.this["private-app"].id]

  tags = { Name = "${local.name}-s3" }
}

# ---------------------------------------------------------------- DB subnet group (used by RDS in Phase 4)

resource "aws_db_subnet_group" "db" {
  name        = "${local.name}-db"
  description = "velza-${var.env} database subnets (isolated, no internet route)."
  subnet_ids  = [for k, s in local.subnets : aws_subnet.this[k].id if s.tier == "db"]

  tags = { Name = "${local.name}-db" }
}

# ---------------------------------------------------------------- security groups
# aws_security_group without inline rules: on create Terraform removes AWS's default allow-all egress rule, so a
# group has exactly the rules below. The rule resources reference each other's groups without a cycle.

resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.this.id
  # No ingress/egress blocks: Terraform removes every rule from the VPC's default SG.

  tags = { Name = "${local.name}-default-locked" }
}

resource "aws_security_group" "this" {
  for_each = {
    alb  = "ALB: HTTPS (and HTTP for the redirect) from the internet, forwards to app."
    app  = "App tasks: only from the ALB; out to the database and HTTPS."
    task = "One-off tasks (migrate, jobs, backup, admin): no inbound; out to the database and HTTPS."
    db   = "RDS: PostgreSQL from app and task only."
  }

  name        = "${local.name}-${each.key}"
  description = each.value
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-${each.key}" }
}

# alb

# trivy AVD-AWS-0107 accepted: The ALB is the public entry point; WAF sits in front of it (Phase 5).
#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.this["alb"].id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = { Name = "${local.name}-alb-in-443" }
}

# trivy AVD-AWS-0107 accepted: Port 80 serves the 80->443 redirect listener from Phase 5. In the fast track
# (docs/golive/FAST_TRACK.md, no domain yet) the :80 listener forwards to the app instead. The description below is
# updated in place (ModifySecurityGroupRules), never a replacement, so Phase 5 can change it back safely.
#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.this["alb"].id
  description       = "HTTP from the internet: forwards to the app in the fast track, redirect to HTTPS from Phase 5"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  tags              = { Name = "${local.name}-alb-in-80" }
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.this["alb"].id
  description                  = "To app tasks"
  referenced_security_group_id = aws_security_group.this["app"].id
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  tags                         = { Name = "${local.name}-alb-out-app" }
}

# app

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.this["app"].id
  description                  = "From the ALB only"
  referenced_security_group_id = aws_security_group.this["alb"].id
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  tags                         = { Name = "${local.name}-app-in-alb" }
}

# app and task have the same outbound rules: database + HTTPS (ECR, SSM, Logs, S3, STS).

resource "aws_vpc_security_group_egress_rule" "to_db" {
  for_each = toset(["app", "task"])

  security_group_id            = aws_security_group.this[each.key].id
  description                  = "PostgreSQL to the database"
  referenced_security_group_id = aws_security_group.this["db"].id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  tags                         = { Name = "${local.name}-${each.key}-out-db" }
}

# trivy AVD-AWS-0104 accepted: Decision D2: no NAT or interface endpoints, so AWS APIs are reached over public HTTPS.
#trivy:ignore:AVD-AWS-0104
resource "aws_vpc_security_group_egress_rule" "https_out" {
  for_each = toset(["app", "task"])

  security_group_id = aws_security_group.this[each.key].id
  description       = "HTTPS to AWS APIs (ECR, SSM, Logs, S3, STS)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = { Name = "${local.name}-${each.key}-out-443" }
}

# db (no egress rules at all)

resource "aws_vpc_security_group_ingress_rule" "db_from" {
  for_each = toset(["app", "task"])

  security_group_id            = aws_security_group.this["db"].id
  description                  = "PostgreSQL from ${each.key}"
  referenced_security_group_id = aws_security_group.this[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  tags                         = { Name = "${local.name}-db-in-${each.key}" }
}

# ---------------------------------------------------------------- outputs (Phase 4 data, Phase 5 app)

output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "subnet_ids" {
  description = "Subnet IDs by tier, in az_ids order: { public = [az1, az2], private_app = [...], db = [...] }."
  value = {
    public      = [aws_subnet.this["public-0"].id, aws_subnet.this["public-1"].id]
    private_app = [aws_subnet.this["private-app-0"].id, aws_subnet.this["private-app-1"].id]
    db          = [aws_subnet.this["db-0"].id, aws_subnet.this["db-1"].id]
  }
}

output "route_table_ids" {
  value = {
    public      = aws_route_table.this["public"].id
    private_app = aws_route_table.this["private-app"].id
    db          = aws_route_table.this["db"].id
  }
}

output "security_group_ids" {
  value = { for k, sg in aws_security_group.this : k => sg.id }
}

output "db_subnet_group_name" {
  value = aws_db_subnet_group.db.name
}

output "s3_endpoint_id" {
  value = aws_vpc_endpoint.s3.id
}
