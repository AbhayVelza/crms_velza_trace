# Account-wide pieces, applied once: GitHub Actions' sign-in to AWS (OIDC, no stored AWS keys) and one deploy role
# per environment. A role can only read its own environment's settings (/velza/<env>/*) and only from this repo's
# matching GitHub environment, so a staging run can never read production secrets.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.80, < 7.0" }
  }
  backend "s3" {
    bucket       = "velza-terraform-state"
    key          = "global/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = { project = "velza", managed_by = "terraform" }
  }
}

variable "github_repository" {
  description = "owner/name of the repository allowed to deploy."
  type        = string
  default     = "AbhayVelza/crms_velza_trace"
}

data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS no longer checks these for GitHub's provider, but older AWS provider versions require the field.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

data "aws_iam_policy_document" "trust" {
  for_each = toset(["staging", "prod"])

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only jobs running in this repo's GitHub environment of the same name (staging / production).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${each.key == "prod" ? "production" : "staging"}"]
    }
  }
}

data "aws_iam_policy_document" "deploy" {
  for_each = toset(["staging", "prod"])

  statement {
    actions   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
    resources = ["arn:aws:ssm:ap-south-1:${data.aws_caller_identity.current.account_id}:parameter/velza/${each.key}/*", "arn:aws:ssm:ap-south-1:${data.aws_caller_identity.current.account_id}:parameter/velza/${each.key}"]
  }
}

resource "aws_iam_role" "deploy" {
  for_each = toset(["staging", "prod"])

  name                 = "velza-${each.key}-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust[each.key].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  for_each = toset(["staging", "prod"])

  name   = "read-velza-${each.key}-settings"
  role   = aws_iam_role.deploy[each.key].id
  policy = data.aws_iam_policy_document.deploy[each.key].json
}

output "deploy_role_arns" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable of the matching GitHub environment."
  value       = { for env, role in aws_iam_role.deploy : env => role.arn }
}
