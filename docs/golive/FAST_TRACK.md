# FAST TRACK: today's app on the go-live shape in the demo account

Goal: run **today's app** (current code, schema v10, no app changes) on the production-sized AWS setup in the demo
account (`138893339714`, Mumbai), try it for a few days, then destroy it. The full phases (4 to 11) and the app
changes (C1 to C11) come after this and **build on the same Terraform modules**.

Who does what: agents wrote the code and ran `terraform fmt` + `validate` only. **You (Kailash) run every command below
with your own short-lived admin sign-in.** No access keys, no passwords in files.

---

## What gets built (prod root only)

| Module | What | Size / setting |
|---|---|---|
| `network` (Phase 3) | VPC `10.40.0.0/16`, 2 AZs (`aps1-az1`, `aps1-az3`), public / reserved private-app / db subnets, IGW, S3 gateway endpoint, DB subnet group, SGs `alb` / `app` / `task` / `db` | no NAT, no interface endpoints (D2) |
| `data` (Phase 4 subset) | RDS PostgreSQL **17**, Multi-AZ DB instance `velza-prod`, parameter group `velza-pg17`, RDS log groups | `db.t4g.large`, gp3 200 GiB (autoscaling to 500), 14-day PITR, TLS only, master password **managed by RDS in Secrets Manager** |
| `registry` (Phase 5 subset) | ECR `velza-app` | immutable tags, scan on push, keeps the 50 newest images |
| `app` (Phase 5 subset) | ALB `velza-prod` (**HTTP :80 only**), ECS cluster `velza-prod`, service `app`, task definition `velza-prod-app`, roles `velza-prod-task-execution` + `velza-prod-app-task` (with the Phase 2 boundary), log group `/velza/prod/app` (30 days) | Fargate x86_64, **1 vCPU / 2 GB**, **1 task** (see below), public IP on (no NAT), health check `GET /api/health` |

`protect = false` (demo), so there is no deletion protection, no final snapshot, and `destroy` removes everything.
The staging root is **not** changed (network only).

### Fast-track shortcuts (all replaced later)

| Shortcut | Why it is OK now | Replaced in |
|---|---|---|
| Plain **HTTP** on the ALB DNS name, no domain | test data only | Phase 5: ACM certificate, HTTPS :443, :80 becomes a redirect, Route 53 `demo.velzaglobal.com` |
| Image built with `HTTPS_ONLY=0` (tag ends in `-http`) | otherwise the browser upgrades every request to https:// and the app can't load (below) | Phase 5: build with `HTTPS_ONLY=1` (`build-push.ps1 -HttpsOnly`) |
| App connects as the **RDS master user** and creates the schema itself on first start | C10 (no DDL from the app) is not built yet; the database is empty | Phase 4: `velza_owner` migrates, app runs as `velza_app` from Parameter Store, `VELZA_SCHEMA_AUTO=off` |
| **1 task** instead of 2 | sign-in lockout, rate limits and damage photos live inside one task today | after C1 (photos on S3) and C8 (shared lockout): `app_desired_count = 2` |

### Not in the fast track (added in the full phases)

| Item | Phase |
|---|---|
| KMS customer-managed keys (D4) | 4 |
| RDS cross-Region automated backups to Hyderabad (D3) | 4 |
| S3 buckets for photos and backups; SSM parameters `/velza/prod/*` for `DATABASE_URL` etc.; `db-bootstrap` task (owner / app / read-only logins) | 4 |
| RDS Enhanced Monitoring | 4 |
| ACM, HTTPS listener, 80 → 443 redirect, Route 53 + health check | 5 |
| WAF web ACL (D8) | 5 |
| Service auto scaling 2–4 | 5 |
| ECR `velza-ops` / `velza-backup`, replication (D6); ops / backup / admin task definitions | 5 |
| EventBridge Scheduler jobs (section 9) | 5 |
| Alarms, dashboard, SNS, metric filters, ECS/RDS event rules, `/velza/prod/jobs` log group | 6 |
| Access Analyzer, break-glass alarms, Trivy/Checkov clean | 7 |
| GitHub release workflows (build, migrate, deploy by digest, rollback); `velza-prod-gha-deploy` widened | 8 |

---

## Step 1. Before the first apply (5 minutes, read-only)

You need: Terraform (you have it), AWS CLI v2 (`winget install -e --id Amazon.AWSCLI` if missing), and your admin
sign-in to the demo account (the same one you used for Phase 2, e.g. `aws login` or `aws sso login --profile <name>`;
if you use a profile, `$env:AWS_PROFILE = "<name>"` in the PowerShell window).

```powershell
aws sts get-caller-identity --query Account --output text          # must print 138893339714

# The two AZ IDs exist and are available:
aws ec2 describe-availability-zones --region ap-south-1 --query "AvailabilityZones[].[ZoneName,ZoneId,State]" --output table

# db.t4g.large PostgreSQL 17 Multi-AZ is offered (look for the two zone NAMES that map to aps1-az1 and aps1-az3):
aws rds describe-orderable-db-instance-options --region ap-south-1 --engine postgres --engine-version 17 --db-instance-class db.t4g.large --query "OrderableDBInstanceOptions[?MultiAZCapable].AvailabilityZones[].Name" --output text

# The parameter group sets wal_compression = lz4. Check RDS allows it (the list must contain lz4):
aws rds describe-engine-default-parameters --region ap-south-1 --db-parameter-group-family postgres17 --query "EngineDefaults.Parameters[?ParameterName=='wal_compression'].AllowedValues" --output text
```

If `lz4` is **not** in the list: in `infra/aws/modules/data/main.tf` change `"wal_compression" = "lz4"` to `"on"`.

## Step 2. Apply the infrastructure (about 30 minutes, mostly RDS)

```powershell
cd C:\Users\KailashChaudhary\Documents\CODE\crms_velza_trace
.\infra\aws\scripts\init.ps1 prod
terraform -chdir=infra/aws/live/prod plan -out="$env:TEMP\velza-prod.tfplan"
```

Read the plan. Expected: **`Plan: 51 to add, 0 to change, 0 to destroy.`**

| Module | Adds | What |
|---|---:|---|
| `module.network` | 35 | as in `infra/aws/README.md` (Phase 3) |
| `module.data` | 4 | parameter group `velza-pg17`, 2 log groups `/aws/rds/instance/velza-prod/{postgresql,upgrade}`, RDS instance `velza-prod` |
| `module.registry` | 2 | ECR `velza-app` + lifecycle policy |
| `module.app` | 10 | log group, 2 IAM roles + 1 role policy, ALB, target group, listener :80, ECS cluster, task definition, service |

(If you applied Phase 3 on its own before, the network is already there: **16 to add, 1 to change**. The one change
is the in-place description update of `module.network.aws_vpc_security_group_ingress_rule.alb_http_redirect`; that is
expected.) Anything outside these modules, any other change or any destroy: stop and ask.

```powershell
terraform -chdir=infra/aws/live/prod apply "$env:TEMP\velza-prod.tfplan"
Remove-Item "$env:TEMP\velza-prod.tfplan"
```

The Multi-AZ database takes about 15 to 30 minutes. **Billing starts now** (about ₹50 an hour, see Cost).

If the apply stops with an error about a **service-linked role** (ECS or Elastic Load Balancing "unable to assume
the service linked role"): this happens the first time an account uses ECS/ALB, because AWS creates that role a moment
too late. Wait a minute, then plan + apply again; only the failed resources are added.

**Chicken and egg:** the service needs an image, the image needs the ECR repository. Solved by the variable
`app_image_tag`: while it is `""` (as committed), the service is created with **0 tasks**. Step 4 pushes the image,
step 5 sets the tag and the service starts 1 task. No `-target` needed.

## Step 3. Install Docker (once)

Docker is not on this PC (`docker --version` said "command not found"). Decision: **build locally with Docker Desktop**
(simplest; no new GitHub workflow). Why not a GitHub Actions build: the build role `velza-gha-build` sits in the
staging root with the **staging** boundary, which denies anything tagged `env = prod` (the ECR repo here is), and its
GitHub environment `build` only runs on `main`. That gets sorted in Phase 5/8.

```powershell
winget install -e --id Docker.DockerDesktop
```

Then restart Windows, start **Docker Desktop**, accept the WSL 2 setup if it asks (it may ask for `wsl --install`
in an admin PowerShell and another restart), wait until it says *Engine running*, and check `docker --version`.

Licence: Docker Desktop is free for companies with **fewer than 250 employees AND less than $10 million revenue**;
otherwise it needs a paid subscription. If Velza is above that, use **Rancher Desktop** (free, open source) instead:
`winget install -e --id SUSE.RancherDesktop`, choose the **dockerd (moby)** engine at first start; the `docker`
command and the scripts work the same.

## Step 4. Build and push the image

Commit your app changes first (the image tag is the commit). Then:

```powershell
.\deploy\aws\build-push.ps1
```

It checks you are in account `138893339714`, builds the `app` target for `linux/amd64` with `HTTPS_ONLY=0`, logs in to
ECR with a 12-hour token from your sign-in, pushes `velza-app:<12-char commit SHA>-http`, logs out, and prints the tag.
The first build takes 5 to 10 minutes.

## Step 5. Start the app

```powershell
.\deploy\aws\roll-app.ps1 -Tag <the tag from step 4>
```

It writes `app_image_tag = "<tag>"` into `infra/aws/live/prod/terraform.tfvars`, runs init + plan, and shows the plan.
Expected for the first roll: **`1 to add, 1 to change, 1 to destroy`**, all under `module.app` (a new task definition
revision replaces the old one, the service moves to it and to 1 task). Type `yes`. It then waits until the service is
stable (2 to 5 minutes) and prints `Health: HTTP 200 {"ok":true}` and the address. If the plan fails or you answer
anything but `yes`, the script puts the previous `app_image_tag` back in `terraform.tfvars`.

**Commit the changed `app_image_tag` line** on your branch, so the code says what runs. (If someone later plans with
`app_image_tag = ""`, Terraform would scale the service to 0.)

Later: a new commit = `build-push.ps1`, then `roll-app.ps1 -Tag <new tag>`. To restart tasks with the same image:
`roll-app.ps1 -ForceNewDeployment`. Linux/Git Bash: `deploy/aws/build-push.sh`, `deploy/aws/roll-app.sh --tag <tag>`.

What happens on the first start: the first `/api/health` call connects to the empty database, creates schema v10, and
creates the two staff sign-ins **AD0001** (Velza Admin) and **HQ0001** (Velza HQ) with random passwords that it prints
once to the log.

## Step 6. Open the app and sign in

```powershell
terraform -chdir=infra/aws/live/prod output -raw app_url       # http://velza-prod-<...>.ap-south-1.elb.amazonaws.com

# The two first-start passwords (printed once, when the database was empty):
aws logs filter-log-events --region ap-south-1 --log-group-name /velza/prod/app --filter-pattern "?AD0001 ?HQ0001" --query "events[].message" --output text
```

Open the `app_url` in Chrome or Edge. The browser shows **"Not secure"** (plain HTTP): fine for this test, but use only
test passwords and test data. Sign in as **AD0001**, open **Account** and change the password; do the same for HQ0001.
(The log keeps the first passwords for 30 days; destroy deletes the log group.)

### How sign-in works over plain HTTP (checked in the code, no app change needed)

- **Session cookie:** `src/lib/api.ts` adds `Secure` only when the request came over HTTPS (`x-forwarded-proto: https`).
  The ALB sends `x-forwarded-proto: http`, so the cookie is set without `Secure` and the browser keeps it.
- **HSTS and `upgrade-insecure-requests`:** both come from `HTTPS_ONLY`, which is **baked in at build time**
  (`next.config.ts`; the Dockerfile defaults to `HTTPS_ONLY=1`). With 1, the browser would fetch every script and API call
  over https:// (no listener there) and the app would not load. `build-push.ps1` therefore builds with `HTTPS_ONLY=0`
  and tags the image `...-http`. HSTS sent over plain HTTP is ignored by browsers anyway.
- **`SIGN_IN`:** a production build always requires sign-in (`src/lib/signInMode.ts`); the task also sets `SIGN_IN=on`.
- **Cross-site check** (`isCrossSiteWrite`): compares `Origin` with `Host`; the ALB passes `Host` through, so it matches.
- **Client IP:** `CLIENT_IP_HEADER` is left unset on purpose. The app then takes the right-most `X-Forwarded-For`
  entry, which is the one the ALB adds (the real client). The log warns once; C9 makes this explicit.
- **Camera scanning needs HTTPS** (browsers allow the camera only on https:// or localhost; the scan screens say so).
  In this test, **type the codes** (or use a USB/Bluetooth scanner, which types). Camera scanning works after Phase 5
  (ACM certificate + domain).

### How the database login flows (no password in files or state)

1. RDS creates the master password and keeps it in Secrets Manager (`manage_master_user_password`). Terraform only
   knows the secret's ARN.
2. The task definition has `DATABASE_URL = postgres://<rds-host>:5432/velza?sslmode=verify-full&sslrootcert=/etc/ssl/aws/rds-global-bundle.pem`
   (no user, no password) and two ECS secrets, `PGUSER` and `PGPASSWORD`, taken from the secret's JSON keys
   `username` and `password` at task start. The execution role may read **only that secret**.
3. node-postgres fills the missing user and password from `PGUSER` / `PGPASSWORD` (checked against `pg` 8.23.1 in this
   repo). TLS is verified against the RDS CA bundle in the image; the parameter group forces TLS (`rds.force_ssl = 1`).
4. **RDS rotates the master password every 7 days.** Running tasks keep the old one, so new database connections fail
   after a rotation. If the test runs that long, run `.\deploy\aws\roll-app.ps1 -ForceNewDeployment` after it
   (next date: `aws secretsmanager describe-secret --secret-id (terraform -chdir=infra/aws/live/prod output -raw db_master_secret_arn) --query NextRotationDate`).
   Phase 4 removes this: the app gets its own `velza_app` login from Parameter Store.

### Why 1 task, not 2

Checked in the code: sign-in lockout (`src/lib/services/auth.ts`, `__velzaLoginFailures`) and rate limits
(`src/lib/security.ts`, `RateLimiter`) live in each process's memory, so with 2 tasks a guesser gets 5 tries per task
(C8). Damage photos are written to the task's own disk (`VELZA_UPLOAD_DIR=/data/uploads`), so a photo saved on one task
is missing on the other (C1). And on an empty database two tasks starting together would both create the schema and
the first sign-ins. So `app_desired_count = 1`. The module and the ALB already work with 2; to see two tasks in two AZs
anyway, set `app_desired_count = 2` and run `roll-app.ps1 -Tag <same tag>` **after** the first start, knowing the
three limits above.

---

## Step 7. 10-minute test checklist

Use one browser window per sign-in (or private windows), because each sign-in is a cookie. Type codes into the scan
box and press Enter (no camera over HTTP). Codes are listed under **Print orders → Codes** (operator).

| # | Sign in as | Screen | Do | Expect |
|---|---|---|---|---|
| 1 | AD0001 | Sign in | sign in with the password from the log; **Account**: change it | lands on the Velza Admin portal |
| 2 | AD0001 | **Partners → Register a partner** | Tier *Manufacturer*, fill the required fields, set the Operator and QC passwords | ID **MF0001**; sign-ins **MF0001-OP** and **MF0001-QC** shown to share |
| 3 | AD0001 | **Partners → Register a partner** | Tier *Customs (Velza)*, required fields, a password | ID **VW0001** |
| 4 | AD0001 | **Devices** | add a device: Manufacturer = MF0001, Name `Demo PC`, Offline unticked | device listed; it gets 10 batch codes |
| 5 | (signed out) | Sign-in page → **Create an account** | type *Super Stockist*, a state, the fields and a password | ID **SS0001**, "waiting for Velza approval" |
| 6 | AD0001 | **Partners → Pending approvals** | **Approve** SS0001 | SS0001 can sign in |
| 7 | MF0001-OP | **New print order** | 1 batch, **1 case**, dates, through the steps; then the print view: **Mark as printed** | order PRINTED: 1 case code + 4 pack codes (see **Print orders → Codes**) |
| 8 | MF0001-QC | **Verify** | scan (type) the case code, then each of its 4 pack codes; **Confirm → PACKED** | lot PACKED |
| 9 | MF0001-OP | **Containers** | **Open container** `TEST-0001`, **Load**: scan the case; choose Customs VW0001 + invoice `FT-INV-1`; **Dispatch container** | container *On the way* |
| 10 | VW0001 | **Receive** | scan `TEST-0001` | the case is *At customs — awaiting clearance* |
| 11 | VW0001 | **Containers** | open TEST-0001 (**Clear**), Bill of Entry `BOE-1`, **Mark cleared** | case *Cleared at customs* |
| 12 | VW0001 | **Dispatch** | destination SS0001, invoice `FT-INV-2`, scan the case, **Confirm dispatch** | case in transit to SS0001 |
| 13 | SS0001 | **Receive** | scan the case | case *At SS* |
| 14 | HQ0001 | **Search code** | the case code, then one pack code | timeline GENERATED → PRINTED → … → RECEIVED at SS0001, with people and invoices; the pack shows its case |
| 15 | HQ0001 | **Scan audit**, **Dashboard** | look | every scan above is listed; counts match |
| 16 | anyone | wrong password 5 times on one ID | | "Too many wrong passwords" (lockout works, one task) |

Optional: Distributor / Retailer through **Create an account** and a further Dispatch → Receive → **Open lot**.
Also look at the logs: CloudWatch → Log groups → `/velza/prod/app` (and `/aws/rds/instance/velza-prod/postgresql`).

---

## Cost (section 11 prices, Mumbai, ₹94/USD)

While the fast-track stack exists (1 task). Billing starts when the RDS instance is created and stops when it is deleted.
A stopped RDS instance still pays for storage (and restarts itself after 7 days), so **destroy, don't stop**.

| Line | USD / hour |
|---|---:|
| RDS `db.t4g.large` Multi-AZ | 0.3340 |
| RDS gp3 200 GiB Multi-AZ ($0.262/GB-month) | 0.0718 |
| Fargate 1 task, 1 vCPU / 2 GB | 0.0519 |
| ALB + ~1 LCU | 0.0319 |
| Public IPv4 × 3 (2 ALB + 1 task) | 0.0150 |
| Secrets Manager (RDS secret), logs, ECR storage | ~0.001 |
| **Total** | **≈ 0.505** |

| | Before GST | With 18 % GST |
|---|---:|---:|
| **Per hour** | ₹47.5 ($0.51) | ₹56 ($0.60) |
| **Per day** | ₹1,140 ($12.1) | ₹1,345 ($14.3) |
| Per week | ₹7,980 | ₹9,415 |
| Infra up, 0 tasks (before step 5) | ₹1,010 / day | ₹1,195 / day |
| 2 tasks instead of 1 | ₹1,270 / day | ₹1,495 / day |

About 80 % of it is the Multi-AZ database. Phase 2 (state bucket, roles, budget) and the network cost ≈ ₹0.

**Budget alerts will fire:** the one demo budget is $30 / $60 / $90 a month, tax included. At ≈ $14.3 a day with GST:
**$30 after about 2 days, $60 after about 4, $90 after about 6**, and the *forecasted > $90* email can arrive on the
first or second day. That is expected: it is the reminder that the stack is running. Cost Anomaly Detection will likely
email too (new RDS spend). A one-week test ≈ ₹9,400 with GST; plan to destroy within a week.

---

## Step 8. Destroy (Kailash, with your admin sign-in)

### A. Remove the fast track, keep Phase 2 (and the network) — normal case

```powershell
.\infra\aws\scripts\init.ps1 prod
terraform -chdir=infra/aws/live/prod destroy -target=module.app -target=module.registry -target=module.data
```

Expected: **`16 to destroy`** (app 10, registry 2, data 4), nothing from `module.ci_access`, `module.state`,
`module.budgets` or `module.network`. Type `yes`. Terraform deletes the service and ALB first, then the database
(10 to 15 minutes), the images with the ECR repo, and the log groups. It warns that `-target` is for exceptional use:
that is expected here.

To remove the network too (free, but nothing needs it): add `-target=module.network` (then **51 to destroy**).

Afterwards set `app_image_tag = ""` again in `infra/aws/live/prod/terraform.tfvars`. While the modules stay in
`main.tf`, a later plan of the prod root shows them as "to add" again; that is expected until the next rehearsal or
Phase 4/5.

### B. Close everything (end of the demo account)

Follow `docs/golive/SWITCH_TO_COMPANY_ACCOUNT.md` section G (staging root first, then prod root with the state bucket
taken out of state, then the bucket by hand). The prod `destroy` there removes the fast-track resources too.

### Leftovers to check (next day)

```powershell
aws rds describe-db-instances --region ap-south-1 --query "DBInstances[].DBInstanceIdentifier"                 # empty
aws rds describe-db-snapshots --region ap-south-1 --query "DBSnapshots[].DBSnapshotIdentifier"                 # no velza-prod-*
aws rds describe-db-instance-automated-backups --region ap-south-1 --query "DBInstanceAutomatedBackups[].DBInstanceIdentifier"  # empty
aws ecr describe-repositories --region ap-south-1 --query "repositories[].repositoryName"                      # no velza-app
aws logs describe-log-groups --region ap-south-1 --log-group-name-prefix /velza/ --query "logGroups[].logGroupName"
aws logs describe-log-groups --region ap-south-1 --log-group-name-prefix /aws/rds/instance/velza-prod --query "logGroups[].logGroupName"
aws secretsmanager list-secrets --region ap-south-1 --include-planned-deletion --query "SecretList[].[Name,DeletedDate]" --output table
aws elbv2 describe-load-balancers --region ap-south-1 --query "LoadBalancers[].LoadBalancerName"                # no velza-prod
aws ec2 describe-addresses --region ap-south-1 --query "Addresses[].PublicIp"                                   # empty
aws ecs list-task-definitions --region ap-south-1 --family-prefix velza-prod-app --status INACTIVE --query "taskDefinitionArns" --output text
```

- RDS: with `protect = false` there is no final snapshot and the automated backups are deleted with the instance.
  Any manual snapshot you made yourself must be deleted by hand.
- Secrets Manager: RDS deletes its `rds!db-...` secret with the instance. If one is still listed, it is no longer
  attached to anything and can be deleted.
- Log groups: Terraform deletes `/velza/prod/app` and `/aws/rds/instance/velza-prod/*`. If RDS wrote logs during the
  delete and re-created one, delete it by hand.
- ECS task definitions: every roll and the destroy leave `velza-prod-app:<n>` revisions as **INACTIVE**. They cost
  nothing; to tidy up, delete them with
  `aws ecs delete-task-definitions --region ap-south-1 --task-definitions <arn> [<arn> ...]` (up to 10 per call).
- On this PC: the built images stay in Docker. `docker images` lists them; remove with `docker image rm <id>` and free
  the build cache with `docker builder prune` (several GB).
- Service-linked roles (`AWSServiceRoleForRDS`, `...ECS`, `...ElasticLoadBalancing`) stay; they are free.
- Then **Cost Explorer** (group by service), the next day and after a week, as in SWITCH section G.

---

## Files

- Terraform: `infra/aws/modules/{data,registry,app}/main.tf`, `infra/aws/live/prod/{main,variables,outputs}.tf`,
  `infra/aws/live/prod/terraform.tfvars` (sizes, `app_desired_count`, `app_image_tag`).
- Scripts: `deploy/aws/build-push.ps1` / `.sh`, `deploy/aws/roll-app.ps1` / `.sh`.
- Permissions boundary: the Phase 2 boundary allows everything here for a later GitHub Actions apply (RDS, ECS, ECR,
  ELB, Logs, SSM, Secrets Manager; `iam:PassRole` on `velza-prod-*`; both new roles carry the boundary).
