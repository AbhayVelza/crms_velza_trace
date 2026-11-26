# App platform for one environment (docs/GO_LIVE_ARCHITECTURE.md sections 2, 4, 6 and 12).
#
#   internet -> ALB velza-<env> (public subnets, SG alb) -> target group velza-<env>-app (HTTP 3000, health check
#   GET /api/health) -> ECS service `app` on cluster velza-<env> (Fargate, Linux x86_64, public subnets with a public
#   IP because there is no NAT (D2), SG app) -> task definition velza-<env>-app (one container `app`).
#
#   IAM (both roles carry the Phase 2 permissions boundary, or a GitHub Actions apply would fail):
#     velza-<env>-task-execution  pulls the image, writes the log group, reads the given secrets and /velza/<env>/*
#     velza-<env>-app-task        the app's own AWS identity; no permissions yet (Phase 4/C1 adds the photo bucket)
#   Log group /velza/<env>/app.
#
# Image: <repository_url>:<image_tag>. While image_tag is "" (nothing pushed yet) the service runs 0 tasks, so the
# first apply can create everything before an image exists (docs/golive/FAST_TRACK.md, "chicken and egg").
#
# What the container gets is decided by the ROOT (`environment`, `secrets`, `secret_arns`), not here, so the fast
# track (master login from the RDS secret) and Phase 4 (velza_app URL from Parameter Store) use the same module.
#
# Fast track: HTTP only. Added in Phase 5, by extending this module: ACM certificate + HTTPS:443 listener
# (ELBSecurityPolicy-TLS13-1-2-2021-06) with port 80 turned into a redirect, Route 53 records and health check, WAF web
# ACL (D8), service auto scaling 2-4 (then desired_count moves to ignore_changes), task definitions for the ops / backup
# / admin images and EventBridge Scheduler (section 9), ECS Exec for the admin task. Phase 8: deploys register task
# definitions outside Terraform (by digest), so the service then ignores task_definition changes.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "env" {
  description = "Environment name: staging or prod. Used in names (velza-<env>-*)."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "protect" {
  description = "true = ALB deletion protection on. false (demo) = terraform destroy removes it."
  type        = bool
}

variable "permissions_boundary_arn" {
  description = "Phase 2 boundary (module.ci_access.boundary_arn). Every role the apply role creates must carry it."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  description = "Public subnets (modules/network subnet_ids.public), one per AZ: ALB nodes and app tasks."
  type        = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "app_security_group_id" {
  type = string
}

variable "repository_url" {
  description = "ECR repository URL of the app image (modules/registry)."
  type        = string
}

variable "repository_arn" {
  description = "ECR repository ARN (the execution role may pull only from it)."
  type        = string
}

variable "image_tag" {
  description = "Image tag to run (a git commit SHA). \"\" = nothing pushed yet: the service runs 0 tasks."
  type        = string

  validation {
    condition     = var.image_tag == "" || can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "image_tag must be \"\" or a valid image tag (letters, digits, _ . -; at most 128)."
  }
}

variable "cpu" {
  description = "Task CPU units (1024 = 1 vCPU, D10)."
  type        = number
}

variable "memory_mib" {
  description = "Task memory in MiB (2048 = 2 GB, D10)."
  type        = number
}

variable "desired_count" {
  description = "Tasks to run once an image exists (D10: 2; the fast track uses 1 until C1/C8, see FAST_TRACK.md)."
  type        = number

  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 4
    error_message = "desired_count must be 0 to 4 (4 is the connection-budget ceiling, architecture section 5)."
  }
}

variable "container_port" {
  type    = number
  default = 3000
}

variable "health_check_path" {
  description = "ALB health check path. /api/health answers 200 only when the task reaches its database."
  type        = string
  default     = "/api/health"
}

variable "health_check_grace_seconds" {
  description = "Seconds after a task starts during which failed ALB health checks don't stop it (first start applies the schema)."
  type        = number
  default     = 120
}

variable "environment" {
  description = "Plain (non-secret) environment variables of the app container."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret environment variables: name -> valueFrom (Secrets Manager ARN[:json-key::] or SSM parameter ARN)."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Secrets Manager secret ARNs the execution role may read (the ones referenced in `secrets`)."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  type    = number
  default = 30
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  name       = "velza-${var.env}"
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  image      = "${var.repository_url}:${var.image_tag == "" ? "not-built-yet" : var.image_tag}"
  desired    = var.image_tag == "" ? 0 : var.desired_count
  ssm_prefix = "arn:aws:ssm:${local.region}:${local.account_id}:parameter/velza/${var.env}"

  # RELEASE_SHA only once there is a tag (an empty value would be dropped by ECS and show as a change on every plan).
  environment = merge(
    var.image_tag == "" ? {} : { RELEASE_SHA = var.image_tag },
    var.environment,
  )
}

# ---------------------------------------------------------------- logs

# trivy AVD-AWS-0017 accepted: AWS-owned encryption for now; the KMS CMK (D4) arrives in Phase 4.
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "app" {
  name              = "/velza/${var.env}/app"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------- IAM

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    # Confused-deputy guard: only ECS acting for this account.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name                 = "${local.name}-task-execution"
  description          = "ECS task execution for velza-${var.env}: pull the image, write logs, read its secrets and /velza/${var.env}/*."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "task_execution" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "PullAppImage"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [var.repository_arn]
  }
  statement {
    sid       = "WriteAppLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }
  statement {
    sid       = "ReadOwnSettings"
    actions   = ["ssm:GetParameters"]
    resources = ["${local.ssm_prefix}/*"]
  }
  dynamic "statement" {
    for_each = length(var.secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadGivenSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = var.secret_arns
    }
  }
  # No kms:Decrypt: the secrets and parameters use AWS-managed keys, whose key policies already allow use through
  # Secrets Manager / SSM. Phase 4 adds kms:Decrypt on the env CMK (D4).
}

resource "aws_iam_role_policy" "task_execution" {
  name   = "${local.name}-task-execution"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution.json
}

resource "aws_iam_role" "app_task" {
  name                 = "${local.name}-app-task"
  description          = "velza-${var.env} app container identity. No permissions yet; the photo bucket comes with Phase 4 / C1."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

# ---------------------------------------------------------------- load balancer

# trivy AVD-AWS-0053 accepted: the ALB is the public entry point by design (WAF in front of it in Phase 5).
#trivy:ignore:AVD-AWS-0053
resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  idle_timeout               = 60
  drop_invalid_header_fields = true
  enable_deletion_protection = var.protect

  tags = { Name = local.name }
}

resource "aws_lb_target_group" "app" {
  name        = "${local.name}-app"
  vpc_id      = var.vpc_id
  target_type = "ip" # Fargate (awsvpc)
  protocol    = "HTTP"
  port        = var.container_port

  deregistration_delay = 30

  health_check {
    path                = var.health_check_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-app" }
}

# FAST TRACK ONLY: port 80 forwards to the app (plain HTTP over the ALB DNS name, no domain yet).
# Phase 5 adds the HTTPS:443 listener with the ACM certificate and turns this listener into a 301 redirect to 443.
# trivy AVD-AWS-0054 accepted for the fast track only: no certificate without a domain (Phase 5).
#trivy:ignore:AVD-AWS-0054
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------------------------------------------------------------- ECS

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled" # standard ECS metrics are free (architecture section 4)
  }

  tags = { Name = local.name }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory_mib)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([merge(
    {
      name      = "app"
      image     = local.image
      essential = true
      portMappings = [{
        containerPort = var.container_port
        hostPort      = var.container_port
        protocol      = "tcp"
      }]
      environment = [for k, v in local.environment : { name = k, value = v }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = local.region
          awslogs-stream-prefix = "app"
        }
      }
      stopTimeout = 30
    },
    length(var.secrets) > 0 ? { secrets = [for k, v in var.secrets : { name = k, valueFrom = v }] } : {},
  )])

  tags = { Name = "${local.name}-app" }

  # A new image = a new revision. Register it first, move the service, then retire the old revision.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_ecs_service" "app" {
  name            = "app"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = local.desired

  launch_type      = "FARGATE"
  platform_version = "LATEST"

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = true # no NAT (D2): the public IP is how a task reaches ECR, Logs and Secrets Manager
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.container_port
  }

  health_check_grace_period_seconds  = var.health_check_grace_seconds
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command  = false
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  wait_for_steady_state   = false

  tags = { Name = "${local.name}-app" }

  # The target group must be attached to a listener before a service can register into it.
  depends_on = [aws_lb_listener.http]
}

# ---------------------------------------------------------------- outputs

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "app_url" {
  description = "Fast track: plain HTTP on the ALB DNS name. Phase 5: https://<domain>."
  value       = "http://${aws_lb.this.dns_name}"
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "task_definition_family" {
  value = aws_ecs_task_definition.app.family
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}

output "target_group_arn" {
  value = aws_lb_target_group.app.arn
}

output "role_arns" {
  value = {
    task_execution = aws_iam_role.task_execution.arn
    app_task       = aws_iam_role.app_task.arn
  }
}
