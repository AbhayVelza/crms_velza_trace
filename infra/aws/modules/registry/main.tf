# Container image registry (docs/GO_LIVE_ARCHITECTURE.md sections 4 and 12): ECR repositories for the velza images.
#
#   per repository   tag immutability (a tag such as a commit SHA always means the same bytes), basic scan on push,
#                    lifecycle: keep the 50 newest images, older ones expire
#
# Fast track (docs/golive/FAST_TRACK.md): the prod root creates only velza-app. Phase 5 adds velza-ops and
# velza-backup (pass them in `repositories`), cross-Region/cross-account replication (D6) and a KMS CMK (D4). In the
# real design the source registry lives in the staging account and prod gets a replica; in the one demo account
# there is only one registry, and it is the one this module creates.
#
# Repository names are NOT prefixed velza-<env>-: the build role (modules/ci_access, velza-gha-build) pushes to
# velza-app / velza-ops / velza-backup, and one image is promoted from staging to prod (build once).
#
# `protect = false` (demo) sets force_delete, so `terraform destroy` also removes a repository that still holds
# images. With `protect = true` a repository with images cannot be deleted by Terraform.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "repositories" {
  description = "ECR repository names to create, e.g. [\"velza-app\"] (Phase 5 adds velza-ops and velza-backup)."
  type        = list(string)

  validation {
    condition     = length(var.repositories) > 0 && alltrue([for r in var.repositories : can(regex("^velza-[a-z0-9-]+$", r))])
    error_message = "repositories must be names like velza-app."
  }
}

variable "keep_images" {
  description = "How many of the newest images each repository keeps; older ones are expired by the lifecycle policy."
  type        = number
  default     = 50
}

variable "protect" {
  description = "true = a repository that holds images cannot be deleted by Terraform. false (demo) = destroy removes it with its images."
  type        = bool
}

# trivy AVD-AWS-0033 accepted: AES256 (AWS-owned key) for now; the KMS CMK (D4) arrives with the full Phase 5.
#trivy:ignore:AVD-AWS-0033
resource "aws_ecr_repository" "this" {
  for_each = toset(var.repositories)

  name                 = each.key
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !var.protect

  image_scanning_configuration {
    scan_on_push = true # basic scanning (free)
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = each.key }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the ${var.keep_images} newest images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.keep_images
      }
      action = { type = "expire" }
    }]
  })
}

output "repository_urls" {
  description = "Repository URL by name, e.g. { velza-app = \"<account>.dkr.ecr.ap-south-1.amazonaws.com/velza-app\" }."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "repository_arns" {
  value = { for k, r in aws_ecr_repository.this : k => r.arn }
}
