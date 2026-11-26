# Checklist: move from the demo account to the company account

The demo account proves the setup works (GO_LIVE_ARCHITECTURE section 13). Real plant data only goes into the company
account(s). The Terraform code stays the same. **Only the two `terraform.tfvars` files change**
(`infra/aws/live/staging/terraform.tfvars`, `infra/aws/live/prod/terraform.tfvars`), plus the one-time bootstrap in
each new account.

Tick each line.

## A. Accounts and owners

- [ ] Decide the layout. The full design (section 4) is Organizations with a management account, `velza-staging` and
      `velza-prod`. Organizations and Identity Center come in a later phase (`live/management`). The steps below cover
      the staging and prod accounts.
- [ ] A named owner for the root user, billing and the MFA device of every account (Q1). Root MFA on (hardware key).
      Root email is a company mailbox, not a personal one.
- [ ] The accounts are on AWS India (AISPL) billing with the company GSTIN, if that is what finance wants.
- [ ] Note each account ID.

## B. Bootstrap in each new account

- [ ] Do [`BOOTSTRAP.md`](BOOTSTRAP.md) Steps 1–6 **in each account**:
      - Step 2: billing access for IAM roles
      - Step 3: state bucket `velza-tfstate-<that account ID>`
      - Step 4: OIDC provider
      - Step 5: the apply role for that account's environment only
      - Step 6: remove the default anomaly monitor

      In the staging account only `velza-staging-gha-tf-apply` is needed. In the prod account only
      `velza-prod-gha-tf-apply` is needed.

## C. Edit only the two variables files

| Setting | staging (company) | prod (company) |
|---|---|---|
| `account_id` | staging account ID | prod account ID |
| `state_bucket` | `velza-tfstate-<staging account ID>` | `velza-tfstate-<prod account ID>` |
| `domain` | `staging.velzaglobal.com` | `app.velzaglobal.com` |
| `protect` | `true` | `true` |
| `manage_account_resources` | **`true`** (it is now its own account) | `true` |
| `budget_name` | `velza-staging-account-monthly` | `velza-prod-account-monthly` |
| `budget_thresholds_usd` | per section 4 (staging ≈ ₹13,000 incl. GST ≈ $138: e.g. `[70, 110, 138]`) | per section 4 (≈ ₹79,000 incl. GST ≈ $840: e.g. `[420, 760, 840]`) |
| `alert_email` | the company ops address | the company ops address |
| `region` / `dr_region` | `ap-south-1` | `ap-south-1` / `ap-south-2` |

- [ ] **There is one budget per account.** In the demo account there was ONE budget for the whole account, created by
      the prod root (staging had `manage_account_resources = false`). With separate accounts, each root owns its own
      account's budget, anomaly monitor and state bucket. So `manage_account_resources = true` in **both**.
- [ ] Budget amounts: section 4 states them in ₹ including GST. AWS Budgets works in USD, so convert at the current
      rate and round. Section 4's rule is no 80 % forecast alert, because normal spend is ≈ 95 % of the budget; keep
      the top threshold = the budget.
- [ ] Nothing else in `infra/aws/` should need editing. If something does, it belongs in tfvars: move it there first.

## D. State

- [ ] The company accounts start with **fresh, empty state** in their own buckets. Do not copy the demo state.
- [ ] Run `infra/aws/scripts/init.ps1 <env> -reconfigure` on your laptop (and the CI workflow reads the new tfvars).
      The old `.terraform/` folder points at the demo bucket; `-reconfigure` resets it without migrating.
- [ ] First apply in the company accounts: prod root, then staging root, as in BOOTSTRAP Step 9. Each plan imports its
      own apply role, and each one (now both) imports its own state bucket.

## E. GitHub

- [ ] Update the GitHub environments `infra-staging`, `infra-prod`, `build`, `staging` and `production`:
      - new role ARNs (`terraform output role_arns`)
      - required reviewers
      - deployment branch `main` only
- [ ] Remove the demo-account role ARNs from GitHub variables.

## F. Things that improve automatically with separate accounts

- [ ] **Cross-environment reads go away completely.** In the shared demo account the boundary already stops every
      GitHub role from reading or writing the other environment's **state** (`live/<other>/*`). But the plan roles'
      `ReadOnlyAccess` still lets them read the other environment's other resources (settings, logs, descriptions).
      This was accepted for the demo because there is no real data. With separate accounts, each role only sees its
      own account.
- [ ] The tag-based "other environment" deny in the permissions boundary stays as a second guard. It is partial: it
      only works for services that check tags in IAM.
- [ ] Boundary changes, apply-role trust changes and teardown are still done by hand by an admin, not by GitHub
      Actions.

## G. Close the demo account

Teardown is run by **Kailash on his laptop with his own admin sign-in**, never by GitHub Actions. The apply roles'
boundary stops them from deleting themselves or the boundary, so a CI destroy would fail halfway. Order:

- [ ] 1. **Staging root.** `.\infra\aws\scripts\init.ps1 staging`, then
      `terraform -chdir=infra/aws/live/staging destroy`. This removes the staging roles (including
      `velza-staging-gha-tf-apply` and `velza-gha-build`) and the staging boundary.
- [ ] 2. **Prod root, keeping the state bucket out of it.** The prod root owns the bucket that holds both states.
      - On your laptop only (don't commit), delete the two `import { ... }` blocks at the end of
        `infra/aws/live/prod/main.tf`, so the destroy can't adopt the bucket again.
      - `.\infra\aws\scripts\init.ps1 prod`
      - `terraform -chdir=infra/aws/live/prod state rm 'module.state[0]'`. Terraform forgets the bucket, which stays.
      - `terraform -chdir=infra/aws/live/prod destroy`. This removes the budget, the anomaly monitor, the prod roles
        (including `velza-prod-gha-tf-apply`) and the prod boundary.
      - `git checkout infra/aws/live/prod/main.tf` to undo the local edit.
- [ ] 3. **State bucket, by hand, last.** S3, select `velza-tfstate-<account ID>`, click **Empty**, then **Delete**.
      With `protect = false` there is no delete-deny in its policy. (If `protect` was ever `true`, delete the bucket
      policy first.)
- [ ] 4. **OIDC provider, by hand,** only if nothing else uses it (the Lightsail pilot may). IAM, Identity providers.
- [ ] 5. In IAM, check that no `velza-staging-*` / `velza-prod-*` / `velza-gha-build` role or `velza-*-gha-boundary`
      policy is left over.
- [ ] **Cost Explorer check** (next day, then after a week): group by service. Look for leftovers:
      - snapshots, including RDS snapshots and cross-Region automated backups in **Hyderabad**
      - ECR images
      - CloudWatch log groups
      - KMS keys pending deletion (charged until deleted)
      - Elastic IPs
      - S3 buckets with old versions
- [ ] Only then close the account. Closing does **not** cancel charges already incurred.
