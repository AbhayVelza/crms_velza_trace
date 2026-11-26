# Remote state in the account's state bucket, S3-native locking (no DynamoDB).
# bucket and region are NOT written here: a backend block cannot read variables, so infra/aws/scripts/init.ps1 / init.sh
# pass them at `terraform init` from this folder's terraform.tfvars (state_bucket, region). One source of truth.
#
# Encryption: deliberately no `encrypt = true`. Without kms_key_id that setting makes Terraform send
# SSE-S3 (AES256) on every write, overriding the bucket default. Leaving it out, every state and lock object gets the
# bucket's default encryption: SSE-KMS with the AWS-managed key aws/s3 (modules/state).
terraform {
  backend "s3" {
    key          = "live/prod/terraform.tfstate"
    use_lockfile = true
  }
}
