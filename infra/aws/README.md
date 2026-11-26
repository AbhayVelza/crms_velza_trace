# infra/aws — go-live Terraform

The go-live AWS setup (`docs/GO_LIVE_ARCHITECTURE.md`). The Lightsail pilot stays in `infra/terraform/` and is not
touched by anything here. Phase 2 is the **foundation**: state bucket, GitHub Actions access, and cost alerts.
Phase 3 adds the **network** (VPC, subnets, S3 gateway endpoint, security groups). Data, app and observability modules
arrive in Phases 4–6.

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
    network/     VPC over 2 AZs, public / private-app (reserved) / db subnets, IGW, S3 gateway endpoint,
                 DB subnet group, security groups alb/app/task/db (Phase 3)
    data/        RDS PostgreSQL 17 Multi-AZ + parameter group velza-pg17 + RDS log groups (fast track; Phase 4 extends)
    registry/    ECR repositories (velza-app in the fast track; Phase 5 adds ops/backup + replication)
    app/         ALB (HTTP :80 in the fast track), ECS cluster/service/task definition, task roles, log group
                 (fast track; Phase 5 adds HTTPS/ACM, WAF, Route 53, auto scaling, scheduler)
  live/
    staging/     root for velza-staging-*
    prod/        root for velza-prod-*  (+ provider alias aws.dr = Hyderabad, for Phase 4)
```

## The one variables file

Everything that differs between the **demo account** and the **company account** is in
`live/<env>/terraform.tfvars` and nowhere else: `account_id`, `region` (`dr_region` in prod), `domain`, `protect`,
`manage_account_resources`, `budget_name`, `budget_thresholds_usd`, `anomaly_threshold_usd`, `alert_email`,
`github_repo`, `state_bucket`, and from Phase 3 `vpc_cidr` and `az_ids`. The file is committed (`.gitignore` has an exception for it), so it must never hold a
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

## Phase 3: network

`modules/network` builds, per root, exactly the layout of `docs/GO_LIVE_ARCHITECTURE.md` section 3 (decision D2):

| | AZ 1 (`az_ids[0]`) | AZ 2 (`az_ids[1]`) | Route table |
|---|---|---|---|
| public `velza-<env>-public-<az-id>` | `x.0/24` | `x.1/24` | `0.0.0.0/0` → IGW + S3 gateway endpoint |
| private-app (**reserved, empty**) | `x.10/24` | `x.11/24` | local only + S3 gateway endpoint (harmless while empty) |
| db | `x.20/24` | `x.21/24` | local only, **no internet route, no endpoint** |

`x` = `10.40` in prod, `10.41` in staging (`vpc_cidr` in each `terraform.tfvars`; the two do not overlap, so both
VPCs fit in the one demo account). No NAT gateway, no interface endpoints.

**Public IPs:** no subnet auto-assigns one (`map_public_ip_on_launch = false` everywhere). The D2 public IP for app
and one-off tasks is set with `assign_public_ip = true` on the ECS service and run-task in Phase 5; the
internet-facing ALB gets its public IPs anyway. So a stray EC2 instance or ENI in a public subnet stays private.

- **Security groups** `velza-<env>-{alb,app,task,db}`, every rule a separate `aws_vpc_security_group_*_rule`
  resource (no inline rules): `alb` in 443 + 80 (80 only for the redirect) from anywhere, out 3000 to `app`;
  `app` in 3000 from `alb`, out 5432 to `db` and 443 anywhere; `task` no inbound, same outbound as `app`;
  `db` in 5432 from `app` and `task`, **no outbound rule**. The VPC's default security group is adopted and emptied
  (`velza-<env>-default-locked`).
- **DB subnet group** `velza-<env>-db` over the two db subnets is created **here**, not in Phase 4: it is pure
  network, free, and keeps the subnets and the group in one place. Phase 4 (`modules/data`) only uses
  `db_subnet_group_name`.
- **S3 gateway endpoint** (default full-access policy on purpose: ECR image layers are pulled from an AWS-owned
  bucket through it, so a policy limited to our buckets would break image pulls).
- **Outputs** for Phases 4/5: `vpc_id`, `subnet_ids` (`public`, `private_app`, `db`, each in `az_ids` order),
  `security_group_ids` (`alb`, `app`, `task`, `db`), `db_subnet_group_name`, `s3_endpoint_id`.
- **IAM:** no new roles. The apply role's boundary allows these EC2/RDS calls; the env-tag denies do not match
  because every resource is tagged with its own `env` through `default_tags`.

**AZ IDs.** Subnets are pinned by AZ **ID** (`aps1-az1`, `aps1-az3`), not by name: `ap-south-1a` can be a different
physical zone in the demo and the company account, an ID cannot. Mumbai has three (`aps1-az1`, `aps1-az2`,
`aps1-az3`); any two give Multi-AZ. Before the first apply in an account, check with your admin sign-in:

```sh
aws ec2 describe-availability-zones --region ap-south-1   --query "AvailabilityZones[].[ZoneName,ZoneId,State]" --output table
# Fargate and the ALB are in every Mumbai AZ; check the RDS class (by AZ name, map it with the table above):
aws rds describe-orderable-db-instance-options --region ap-south-1 --engine postgres   --db-instance-class db.t4g.large --query "OrderableDBInstanceOptions[].AvailabilityZones[].Name" --output text
```

Changing `az_ids` later replaces the subnets (and everything in them), so settle it before Phase 4.

**Apply.** Staging and prod are independent (different VPCs, CIDRs and states), so either order works; staging
first is the habit. Re-run `init.ps1 <env>` first (the root now uses a new module). The plan for each root should
show **35 to add, 0 to change, 0 to destroy**, all under `module.network`: 1 VPC, 1 internet gateway, 6 subnets,
3 route tables, 1 route (`0.0.0.0/0` on public), 6 route-table associations, 1 S3 gateway endpoint, 1 DB subnet
group, 1 default security group (adopted and emptied), 4 security groups, 10 security group rules. Anything outside
`module.network`, any change or any destroy means something drifted: stop and look before approving.

**Rollback.** Revert the Phase 3 commit and apply: the plan must show only `module.network` destroys (35). This is
safe while the VPCs are empty; once Phase 4/5 resources (RDS, ALB, tasks) use the subnets or security groups, AWS
blocks the destroy, and those phases must be rolled back first.

**Cost.** VPC, subnets, route tables, internet gateway, security groups, DB subnet group and the S3 gateway
endpoint cost **nothing**. Public IPv4 addresses ($0.005/hour each) are billed only once the ALB and tasks exist
(Phase 5). Phase 3 alone adds ₹0 a month.

## Fast track: data, registry, app (prod root only)

`docs/golive/FAST_TRACK.md` runs today's app (schema v10) on the go-live shape in the demo account: modules `data`,
`registry` and `app` are wired into the **prod root only** (staging stays network-only). Sizes, `app_desired_count`
and `app_image_tag` are in `live/prod/terraform.tfvars`. While `app_image_tag = ""` the service runs 0 tasks.
`deploy/aws/build-push.ps1` builds and pushes the image, `deploy/aws/roll-app.ps1 -Tag <tag>` sets the tag and applies.
First apply of the prod root with Phase 3 not yet applied: **51 to add** (network 35, data 4, registry 2, app 10).
The new roles `velza-prod-task-execution` and `velza-prod-app-task` carry the boundary, so a later GitHub apply works.

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
