# infra/aws — go-live Terraform

The go-live AWS setup (`docs/GO_LIVE_ARCHITECTURE.md`). The Lightsail pilot stays in `infra/terraform/` and is not
touched by anything here. Phase 2 (this folder today) is the **foundation**: state bucket, GitHub Actions access, and
cost alerts. Network, data, app and observability modules arrive in Phases 3–6.

**Nothing here is applied by an agent.** Applies run through GitHub Actions (`infra-apply.yml`, Phase 8) with
Kailash's approval, or by Kailash himself. Before the first apply, do the one-time console steps in
[`docs/golive/BOOTSTRAP.md`](../../docs/golive/BOOTSTRAP.md).

```
infra/aws/
  scripts/init.ps1, init.sh   terraform init <env>, backend bucket/region taken from that env's terraform.tfvars
  modules/
    state/       S3 state bucket velza-tfstate-<account-id> (versioned, SSE-KMS aws/s3, TLS-only, no public access)
    ci_access/   GitHub OIDC roles velza-<env>-gha-{tf-plan,tf-apply,deploy}, velza-gha-build, permissions boundary
    budgets/     ONE monthly account budget (no env filter) + Cost Anomaly Detection (per-service monitor, daily email)
  live/
    staging/     root for velza-staging-*
    prod/        root for velza-prod-*  (+ provider alias aws.dr = Hyderabad, for Phase 4)
```

## The one variables file

Everything that differs between the **demo account** and the **company account** is in
`live/<env>/terraform.tfvars` and nowhere else: `account_id`, `region` (`dr_region` in prod), `domain`, `protect`,
`manage_account_resources`, `budget_name`, `budget_thresholds_usd`, `anomaly_threshold_usd`, `alert_email`,
`github_repo`, `state_bucket`. The file is committed (`.gitignore` has an exception for it), so it must never hold a
secret. Placeholders (`000000000000`, `CHANGE_ME@example.com`) are rejected by validation, so a plan cannot run until
they are filled in.

The backend block cannot read variables (a Terraform limit), so `backend.tf` only holds `key` and `use_lockfile`.
The scripts pass `bucket` and `region` from the same tfvars:

```powershell
.\infra\aws\scripts\init.ps1 staging      # Windows
```
```sh
infra/aws/scripts/init.sh prod            # Linux / CI
```

## Account-wide things: `manage_account_resources`

The state bucket, the budget and the per-service anomaly monitor exist **once per AWS account** (AWS allows only one
per-service anomaly monitor). Exactly one root per account sets `manage_account_resources = true`:

| Account | staging root | prod root |
|---|---|---|
| Demo (one shared account) | `false`: no bucket, **no budget**, no anomaly monitor | `true`: state bucket + the ONE budget `velza-demo-account-monthly` ($30/$60/$90, tax included, whole account, no env filter) + anomaly monitor |
| Company (separate accounts) | `true` (its own account) | `true` (its own account) |

## State

One state file per root: `live/<env>/terraform.tfstate` in `velza-tfstate-<account-id>`, S3-native locking
(`use_lockfile = true`, Terraform ≥ 1.10, no DynamoDB).

Encryption: the bucket's **default encryption is SSE-KMS with the AWS-managed key `aws/s3`** (bucket key on, no
monthly key fee). The backends deliberately do **not** set `encrypt = true`: without a `kms_key_id` that setting makes
Terraform request SSE-S3 (AES256) on every write and override the bucket default. The bucket policy refuses SSE-S3
writes, so a backend with `encrypt = true` fails loudly instead of silently weakening encryption.

Saved plans (`*.tfplan`) hold resource values and can hold secrets: write them outside the repo, never commit them
(`.gitignore` blocks `*.tfplan` and `tfplan`). The bucket and the two `velza-<env>-gha-tf-apply` roles are made
by hand in bootstrap and adopted by `import {}` blocks in `main.tf` on the first apply (after that the blocks do
nothing). The bucket import is gated by `manage_account_resources`, so only the prod root (demo) adopts it.

## Deletion protection (`protect`)

`lifecycle { prevent_destroy }` cannot take a variable. So `protect = true` sets `force_destroy = false` on the state
bucket and adds a bucket-policy Deny on `s3:DeleteBucket`. Demo: `protect = false`, so `terraform destroy` removes
everything. Later phases use `protect` for RDS/ALB deletion protection.

## Permissions boundary

Every GitHub Actions role carries `velza-<env>-gha-boundary`. It blocks:

- Organizations, account, billing and Identity Center actions; IAM users with passwords or access keys
- removing a boundary, or creating a role **without** this boundary
- writing to, passing (`iam:PassRole`) or assuming (`sts:AssumeRole`) **any role whose name is not `velza-<env>-*`**
  (plus `velza-gha-build` in the staging root and AWS service-linked roles). So the apply role can't take over
  untagged roles like `OrganizationAccountAccessRole`, the pilot's roles or hand-made admin roles.
- changing **its own** apply role: trust policy, boundary, detaching policies, deleting it
- changing the boundary policy itself
- reading or writing the other environment's state (`live/<other>/*`), and changing the state bucket's settings
  unless this root owns the bucket
- resources tagged `env = <other env>`. This guard is **partial**: it only works where the AWS service supports
  `aws:ResourceTag` / `aws:RequestTag` in IAM and the resource carries the tag. The real separation is the
  `velza-<env>-*` names and, in the company account, separate accounts.

Consequences:

- Every IAM role that later phases create (ECS task roles, scheduler role) must be named `velza-<env>-*` and set
  `permissions_boundary = module.ci_access.boundary_arn`, or the GitHub apply fails.
- Changes to the boundary policy or to an apply role's trust policy can't be applied by GitHub Actions. Kailash
  applies them himself with his admin sign-in.

## Teardown (demo)

GitHub Actions cannot destroy its own apply role or the boundary, so **teardown is run by Kailash with his admin
sign-in**, never by CI. The steps and order are in
[`docs/golive/SWITCH_TO_COMPANY_ACCOUNT.md`](../../docs/golive/SWITCH_TO_COMPANY_ACCOUNT.md) section G: staging root
first, prod root last, with the state bucket taken out of the prod state first and deleted by hand at the very end.

## Checks (what agents may run)

```sh
terraform fmt -check -recursive infra/aws
terraform -chdir=infra/aws/live/staging init -backend=false && terraform -chdir=infra/aws/live/staging validate
terraform -chdir=infra/aws/live/prod    init -backend=false && terraform -chdir=infra/aws/live/prod    validate
```

Provider versions are pinned (`terraform ~> 1.10`, `hashicorp/aws ~> 6.0`). Each root's `.terraform.lock.hcl` is
committed with hashes for `linux_amd64` and `windows_amd64`. To refresh it:
`terraform -chdir=infra/aws/live/<env> providers lock -platform=linux_amd64 -platform=windows_amd64`.
