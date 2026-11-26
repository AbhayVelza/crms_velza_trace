# Terraform state bucket for one AWS account: velza-tfstate-<account-id>.
#
# The bucket itself is made by hand once (docs/golive/BOOTSTRAP.md) because Terraform needs it before it can store any
# state. The root that owns it adopts it with an `import {}` block; from then on this module keeps its settings:
# versioning, SSE-KMS (AWS-managed key aws/s3 + bucket key) as the bucket default (the backends do not set `encrypt`,
# see live/*/backend.tf; SSE-S3 writes are refused), public access blocked, BucketOwnerEnforced, TLS-only,
# old versions expire. Locking is S3-native (`use_lockfile = true`, Terraform >= 1.10), so no DynamoDB table.
#
# `protect`: `lifecycle { prevent_destroy }` cannot take a variable, so protection is done with
#   - force_destroy = !protect (a protected bucket that still holds state can never be deleted by Terraform), and
#   - a bucket-policy Deny on s3:DeleteBucket while protect = true (also stops deletion from the console/CLI;
#     the account root user can still remove the bucket policy in an emergency).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "bucket_name" {
  description = "Name of the state bucket (velza-tfstate-<account-id>)."
  type        = string
}

variable "protect" {
  description = "true = the bucket cannot be deleted (real account). false = terraform destroy may remove it (demo)."
  type        = bool
}

variable "noncurrent_version_days" {
  description = "Days an old (overwritten) state version is kept before it is deleted."
  type        = number
  default     = 90
}

resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = !var.protect
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms" # no key id = the AWS-managed key aws/s3 (no monthly key fee)
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Writes get the bucket default (SSE-KMS, aws/s3). Refuse writes that ask for SSE-S3 instead (e.g. a backend
  # block with `encrypt = true` and no kms_key_id), so state can't silently fall back to weaker encryption.
  statement {
    sid     = "DenySseS3Writes"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = ["${aws_s3_bucket.this.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["AES256"]
    }
  }

  dynamic "statement" {
    for_each = var.protect ? [1] : []
    content {
      sid     = "DenyBucketDeletion"
      effect  = "Deny"
      actions = ["s3:DeleteBucket"]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      resources = [aws_s3_bucket.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

output "bucket_name" {
  value = aws_s3_bucket.this.id
}

output "bucket_arn" {
  value = aws_s3_bucket.this.arn
}
