# GitHub Actions -> AWS for one environment, through OIDC (no stored AWS keys).
#
# Roles (all trust only this repo, audience sts.amazonaws.com, one exact `sub`, 1-hour sessions, and all carry the
# permissions boundary velza-<env>-gha-boundary):
#   velza-<env>-gha-tf-plan   sub repo:<repo>:pull_request          ReadOnlyAccess + state read + lock file write
#   velza-<env>-gha-tf-apply  sub repo:<repo>:environment:infra-<env> AdministratorAccess, limited by the boundary
#   velza-<env>-gha-deploy    sub repo:<repo>:environment:<staging|production>  read /velza/<env>/* settings + logs
#                             (widened in Phase 5 to ECS/ECR/RDS snapshot on velza-<env>-* resources)
#   velza-gha-build           sub repo:<repo>:environment:build      push to the ECR repos (only where create_build_role;
#                             GitHub environment `build` is limited to the main branch, so pull_request_target and
#                             other events on main cannot use it)
#
# The GitHub OIDC identity provider exists once per account. It is made by hand in bootstrap (or is the Lightsail
# pilot's, infra/terraform/global), so it is only LOOKED UP here, never created: no two states fight over it.
#
# The boundary (what even AdministratorAccess cannot do):
#   - Organizations, account settings, billing/payments/tax, IAM Identity Center
#   - IAM users with passwords or access keys
#   - remove a permissions boundary, or create/re-bound a role without THIS boundary
#   - change or delete the boundary policy itself (so boundary changes are applied by a human admin, not by CI)
#   - write to, pass or assume any IAM role whose name is not velza-<env>-* (plus velza-gha-build where this root
#     owns it, and AWS service-linked roles). This closes the escape through untagged roles such as
#     OrganizationAccountAccessRole, the pilot's roles or hand-made admin roles.
#   - change its own apply role's trust policy or boundary, detach its policies, or delete it (a human admin does that)
#   - read or write the OTHER environment's state (live/<other>/*), or change the state bucket's settings unless this
#     root owns the bucket
#   - touch resources tagged env = <other env>, or create something with that tag. This guard is PARTIAL: it only
#     works for services that support aws:ResourceTag / aws:RequestTag in IAM, and only for resources that carry the
#     tag. Names (velza-<env>-*) and, in the company account, separate accounts are the main separation.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "env" {
  description = "Environment name: staging or prod."
  type        = string

  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to sign in."
  type        = string
}

variable "github_deploy_environment" {
  description = "GitHub environment used by release deploys (staging / production)."
  type        = string
}

variable "state_bucket" {
  description = "Name of the Terraform state bucket of this account."
  type        = string
}

variable "state_key" {
  description = "Object key of this root's state file in the state bucket."
  type        = string
}

variable "manages_state_bucket" {
  description = "true = this root owns the state bucket's settings (manage_account_resources); false = it may only use its own state objects."
  type        = bool
}

variable "create_build_role" {
  description = "true = also create velza-gha-build (ECR push, GitHub environment build). Only one root per account sets this."
  type        = bool
  default     = false
}

variable "ecr_repositories" {
  description = "ECR repository names velza-gha-build may push to."
  type        = list(string)
  default     = ["velza-app", "velza-ops", "velza-backup"]
}

locals {
  other_env     = var.env == "prod" ? "staging" : "prod"
  oidc_host     = "token.actions.githubusercontent.com"
  oidc_arn      = data.aws_iam_openid_connect_provider.github.arn
  boundary_name = "velza-${var.env}-gha-boundary"
  boundary_arn  = "arn:aws:iam::${var.account_id}:policy/${local.boundary_name}"
  state_bucket  = "arn:aws:s3:::${var.state_bucket}"
  repo_sub      = "repo:${var.github_repo}"
  # State keys follow live/<env>/... (backend.tf); the other env's prefix is denied in the boundary.
  own_state_arns    = ["${local.state_bucket}/${var.state_key}", "${local.state_bucket}/${var.state_key}.tflock"]
  other_state_arn   = "${local.state_bucket}/live/${local.other_env}/*"
  role_prefix_arn   = "arn:aws:iam::${var.account_id}:role/velza-${var.env}-*"
  build_role_arn    = "arn:aws:iam::${var.account_id}:role/velza-gha-build"
  slr_arn           = "arn:aws:iam::${var.account_id}:role/aws-service-role/*"
  apply_role_arn    = "arn:aws:iam::${var.account_id}:role/velza-${var.env}-gha-tf-apply"
  allowed_role_arns = concat([local.role_prefix_arn, local.slr_arn], var.create_build_role ? [local.build_role_arn] : [])
  ssm_path_arn      = "arn:aws:ssm:${var.region}:${var.account_id}:parameter/velza/${var.env}"
  log_groups_arn    = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/velza/${var.env}/*"
}

# ---------------------------------------------------------------- OIDC provider

data "aws_iam_openid_connect_provider" "github" {
  url = "https://${local.oidc_host}"
}

# ---------------------------------------------------------------- permissions boundary

data "aws_iam_policy_document" "boundary" {
  statement {
    sid       = "AllowEverythingElse"
    actions   = ["*"]
    resources = ["*"]
  }

  statement {
    sid    = "DenyOrgBillingIdentityCenter"
    effect = "Deny"
    actions = [
      "organizations:*", "account:*", "aws-portal:*", "billing:*", "payments:*", "tax:*", "invoicing:*",
      "consolidatedbilling:*", "freetier:*", "sso:*", "sso-directory:*", "identitystore:*",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "DenyIamUsersWithCredentials"
    effect    = "Deny"
    actions   = ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile"]
    resources = ["*"]
  }

  statement {
    sid       = "DenyBoundaryRemoval"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary", "iam:DeleteUserPermissionsBoundary"]
    resources = ["*"]
  }

  statement {
    sid       = "DenyRolesWithoutThisBoundary"
    effect    = "Deny"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }

  statement {
    sid    = "DenyChangingTheBoundary"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy", "iam:UntagPolicy",
    ]
    resources = [local.boundary_arn]
  }

  statement {
    sid    = "DenyRoleWritesOutsideThisEnv"
    effect = "Deny"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
      "iam:TagRole", "iam:UntagRole", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary",
      "iam:PassRole", "sts:AssumeRole",
    ]
    not_resources = local.allowed_role_arns
  }

  statement {
    sid    = "DenyChangingOwnApplyRole"
    effect = "Deny"
    actions = [
      # Not AttachRolePolicy/PutRolePolicy: the boundary caps any policy the role adds to itself, so it cannot escalate.
      "iam:UpdateAssumeRolePolicy", "iam:DeleteRole", "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary",
    ]
    resources = [local.apply_role_arn]
  }

  statement {
    sid       = "DenyOtherEnvironmentState"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.other_state_arn]
  }

  dynamic "statement" {
    for_each = var.manages_state_bucket ? [] : [1]
    content {
      sid       = "DenyStateBucketSettings"
      effect    = "Deny"
      actions   = ["s3:PutBucket*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration", "s3:PutEncryptionConfiguration", "s3:PutBucketOwnershipControls", "s3:PutBucketPublicAccessBlock"]
      resources = [local.state_bucket]
    }
  }

  statement {
    sid           = "DenyOtherEnvironmentResources"
    effect        = "Deny"
    actions       = ["*"]
    not_resources = concat([local.state_bucket], local.own_state_arns)
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [local.other_env]
    }
  }

  statement {
    sid           = "DenyCreatingOtherEnvironmentTags"
    effect        = "Deny"
    actions       = ["*"]
    not_resources = concat([local.state_bucket], local.own_state_arns)
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [local.other_env]
    }
  }
}

resource "aws_iam_policy" "boundary" {
  name        = local.boundary_name
  description = "Permissions boundary for velza-${var.env} GitHub Actions roles. Changed only by a human admin."
  policy      = data.aws_iam_policy_document.boundary.json
}

# ---------------------------------------------------------------- trust policies

data "aws_iam_policy_document" "trust" {
  for_each = {
    plan   = "${local.repo_sub}:pull_request"
    apply  = "${local.repo_sub}:environment:infra-${var.env}"
    deploy = "${local.repo_sub}:environment:${var.github_deploy_environment}"
    build  = "${local.repo_sub}:environment:build"
  }

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = [each.value]
    }
  }
}

# ---------------------------------------------------------------- tf-plan (pull requests)

resource "aws_iam_role" "tf_plan" {
  name                 = "velza-${var.env}-gha-tf-plan"
  description          = "GitHub Actions terraform plan on pull requests (read-only)."
  assume_role_policy   = data.aws_iam_policy_document.trust["plan"].json
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "tf_plan_readonly" {
  role       = aws_iam_role.tf_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "tf_plan_state" {
  statement {
    sid       = "ListStateBucket"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket]
  }
  statement {
    sid       = "ReadOwnState"
    actions   = ["s3:GetObject"]
    resources = ["${local.state_bucket}/${var.state_key}"]
  }
  statement {
    sid       = "PlanTakesTheLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state_bucket}/${var.state_key}.tflock"]
  }
  statement {
    sid       = "StateEncryptionViaS3"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.state_bucket, "${local.state_bucket}/*"]
    }
  }
}

resource "aws_iam_role_policy" "tf_plan_state" {
  name   = "terraform-state"
  role   = aws_iam_role.tf_plan.id
  policy = data.aws_iam_policy_document.tf_plan_state.json
}

# ---------------------------------------------------------------- tf-apply (environment infra-<env>, approval)
# Made by hand in bootstrap and adopted by the root's import block; the trust policy here is the same JSON as in
# docs/golive/BOOTSTRAP.md, so adopting it changes nothing but tags and the boundary. Once the boundary is on, the
# role cannot change its own trust policy or boundary, detach its policies, nor delete itself: those changes (and teardown of
# this role) are applied by Kailash with his admin sign-in.

resource "aws_iam_role" "tf_apply" {
  name                 = "velza-${var.env}-gha-tf-apply"
  description          = "GitHub Actions terraform apply for velza-${var.env} (environment infra-${var.env})."
  assume_role_policy   = data.aws_iam_policy_document.trust["apply"].json
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "tf_apply_admin" {
  role       = aws_iam_role.tf_apply.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# ---------------------------------------------------------------- deploy (environment staging / production)

resource "aws_iam_role" "deploy" {
  name                 = "velza-${var.env}-gha-deploy"
  description          = "GitHub Actions release deploy for velza-${var.env}. Widened in Phase 5."
  assume_role_policy   = data.aws_iam_policy_document.trust["deploy"].json
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "ReadOwnSettings"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = [local.ssm_path_arn, "${local.ssm_path_arn}/*"]
  }
  statement {
    sid       = "ReadOwnLogs"
    actions   = ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"]
    resources = [local.log_groups_arn, "${local.log_groups_arn}:*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "velza-${var.env}-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# ---------------------------------------------------------------- build (main branch, ECR push)

resource "aws_iam_role" "build" {
  count = var.create_build_role ? 1 : 0

  name                 = "velza-gha-build"
  description          = "GitHub Actions image build on main: push to the velza ECR repositories."
  assume_role_policy   = data.aws_iam_policy_document.trust["build"].json
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600
}

data "aws_iam_policy_document" "build" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushImages"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages",
      "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
    ]
    resources = [for r in var.ecr_repositories : "arn:aws:ecr:${var.region}:${var.account_id}:repository/${r}"]
  }
}

resource "aws_iam_role_policy" "build" {
  count = var.create_build_role ? 1 : 0

  name   = "ecr-push"
  role   = aws_iam_role.build[0].id
  policy = data.aws_iam_policy_document.build.json
}

# ---------------------------------------------------------------- outputs

output "oidc_provider_arn" {
  value = local.oidc_arn
}

output "boundary_arn" {
  description = "Every IAM role created by the apply role must carry this boundary (Phase 4+ task roles too)."
  value       = aws_iam_policy.boundary.arn
}

output "role_arns" {
  description = "Put these into the matching GitHub environment variables."
  value = merge(
    {
      tf_plan  = aws_iam_role.tf_plan.arn
      tf_apply = aws_iam_role.tf_apply.arn
      deploy   = aws_iam_role.deploy.arn
    },
    var.create_build_role ? { build = aws_iam_role.build[0].arn } : {},
  )
}
