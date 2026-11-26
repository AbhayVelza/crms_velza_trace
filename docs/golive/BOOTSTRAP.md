# Bootstrap: the one-time steps by hand in the AWS console (demo account)

Terraform needs a few things before it can run: a bucket to keep its state in, and a way for GitHub Actions to sign in
to AWS. You make these **once, by hand**. After that, Terraform takes them over (the `import` blocks in
`infra/aws/live/*/main.tf`) and everything else is code.

> **Status (demo account): steps 1–9 done on 26 Nov 2026.** First applies by Kailash: prod 2 imported, 16 added,
> 2 changed; staging 1 imported, 9 added, 1 changed. Step 10 is next.

Time needed: about 30 minutes. You need the demo account's admin sign-in with MFA. Nobody else needs any AWS password
or key, and **no access keys are created anywhere**.

Write these down as you go:

| What | Example | Where it goes |
|---|---|---|
| Account ID (12 digits) | `123456789012` | `account_id` and `state_bucket` in both `terraform.tfvars` |
| Alert email | `ops@yourcompany.com` | `alert_email` in both `terraform.tfvars` |

---

## Step 1. Sign in and pick Mumbai

1. Open <https://console.aws.amazon.com/> and sign in to the **demo** account with MFA.
2. Top right, open the region menu and choose **Asia Pacific (Mumbai) ap-south-1**. Check it says Mumbai before each step.
3. Top right, click your account name. Copy the **Account ID** (12 digits, without dashes).

## Step 2. Let IAM roles see billing data (for Budgets and Cost Anomaly Detection)

1. Click your account name (top right), then **Account**.
2. Scroll to **IAM user and role access to Billing information** and click **Edit**.
3. Tick **Activate IAM Access** and click **Update**.

(Only the root user can change this. If the page says you need the root user, sign in as root once, with MFA, then
sign out again.)

## Step 3. Create the Terraform state bucket

1. Search for **S3** at the top and open it, then click **Create bucket**.
2. **Bucket type**: General purpose.
3. **Bucket name**: `velza-tfstate-<account ID>`, for example `velza-tfstate-123456789012`.
4. **Object Ownership**: ACLs disabled (recommended). This is "Bucket owner enforced".
5. **Block Public Access**: leave **Block all public access** ticked.
6. **Bucket Versioning**: **Enable**.
7. **Tags** (Add tag): `project` = `velza`, `env` = `prod`, `managed_by` = `terraform`.
8. **Default encryption**: choose **Server-side encryption with AWS Key Management Service keys (SSE-KMS)**, then
   **AWS managed key (aws/s3)**. Set **Bucket Key** to **Enable**.
9. **Object Lock**: leave it disabled.
10. Click **Create bucket**.

You don't need to add a bucket policy or lifecycle rule. Terraform adds them on the first apply (TLS only, old state
versions deleted after 90 days).

## Step 4. Let GitHub sign in to AWS (OIDC identity provider)

1. Search for **IAM** and open it, then click **Identity providers** on the left.
2. If the list already has `token.actions.githubusercontent.com` (the Lightsail pilot may have made it), **skip to
   Step 5**. Terraform uses the existing one and never changes or deletes it.
3. Otherwise click **Add provider**:
   - **Provider type**: OpenID Connect
   - **Provider URL**: `https://token.actions.githubusercontent.com`
   - **Audience**: `sts.amazonaws.com`
   - Click **Add provider**.

## Step 5. Create the two "apply" roles

GitHub Actions uses these to run `terraform apply` after you approve. Do this twice: once for **staging** and once for
**prod**.

1. In IAM, click **Roles**, then **Create role**.
2. **Trusted entity type**: **Custom trust policy**. Delete the example text and paste the JSON below. Replace
   `<ACCOUNT_ID>` with your 12-digit account ID, and use `infra-staging` or `infra-prod` as shown.

   For **staging**:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": "repo:AbhayVelza/crms_velza_trace:environment:infra-staging"
           }
         }
       }
     ]
   }
   ```
   For **prod**, use the same JSON but end the `sub` line with `:environment:infra-prod`.

   Only a GitHub Actions job in this repository, running in the GitHub environment `infra-staging` (or `infra-prod`),
   can use the role. You decide who approves those environments (Step 8).
3. Click **Next**. Search for **AdministratorAccess**, tick it, and click **Next**.
4. **Role name**: `velza-staging-gha-tf-apply`, and for prod `velza-prod-gha-tf-apply`. The name must be exactly
   this, because Terraform finds the role by name.
5. **Tags**: `project` = `velza`, `env` = `staging` (or `prod`), `managed_by` = `terraform`.
6. Click **Create role**.

On the first apply, Terraform adds a **permissions boundary** to these roles (`velza-<env>-gha-boundary`). After that,
even with AdministratorAccess, the roles cannot:
- touch Organizations, billing or Identity Center
- create IAM users with passwords or keys
- change, pass or assume any IAM role whose name does not start with `velza-<env>-` (so not
  `OrganizationAccountAccessRole`, the pilot's roles or your own admin roles)
- change their own trust policy or boundary, or delete themselves
- read or write the other environment's Terraform state
- change the boundary itself

There is also a guard against touching resources tagged with the other environment (`env = prod` for staging and the
other way round). It is **partial**: it only works for AWS services that check tags in IAM. The real separation is
the `velza-<env>-` names, and later the separate company accounts.

**So these changes must be applied by you, Kailash, by hand** (your own admin sign-in, `terraform apply` for that
root): any change to the boundary policy, and any change to an apply role's trust policy. GitHub Actions will fail on
them, and that is on purpose. For the same reason, tearing the demo down is done by you, not by GitHub
(`SWITCH_TO_COMPANY_ACCOUNT.md` section G).

## Step 6. Remove AWS's default anomaly monitor (if there is one)

AWS allows only **one** "AWS services" anomaly monitor per account, and some accounts get one automatically. Terraform
makes its own (`velza-account-services`), so remove the automatic one first.

1. Search for **Cost Anomaly Detection** (it is part of Billing and Cost Management) and open it.
2. Click the **Cost monitors** tab.
3. If you see a monitor of type **AWS services** (often named `Default-Services-Monitor`), select it, then click
   **Actions** and **Delete**. Delete its alert subscription too if AWS asks.
4. If the list is empty, there is nothing to do.

## Step 7. Fill in the two variables files

Edit `infra/aws/live/prod/terraform.tfvars` and `infra/aws/live/staging/terraform.tfvars`:

| Setting | Value |
|---|---|
| `account_id` | the 12-digit account ID (same in both files) |
| `state_bucket` | `velza-tfstate-<account ID>` (same in both files) |
| `alert_email` | the address for cost alerts |
| `domain` | the test subdomain once Q2 is answered (not used before Phase 5) |

Leave everything else as it is. In particular:

- **There is ONE budget for the whole demo account**: `velza-demo-account-monthly`, with alerts at **$30, $60 and $90
  a month, tax included** (GST on an AWS India bill). The **prod** root creates it, because it has
  `manage_account_resources = true`. It has **no environment filter**, so it counts everything in the account,
  staging included.
- The **staging** root has `manage_account_resources = false`. It creates **no** budget, **no** anomaly monitor and no
  state bucket. Its budget lines are only kept for the company account later.

The tfvars files are committed to git, so **never put a password or key in them**. If a placeholder
(`000000000000`, `CHANGE_ME@example.com`) is left in, the plan stops with a clear error.

What the alerts mean: $30 / $60 / $90 is about ₹2,800 / ₹5,600 / ₹8,500. When the full rehearsal stack runs (about
₹2,300 a day with GST, GO_LIVE_ARCHITECTURE section 13), the $30 alert arrives within about a day and $90 within
about four days. That is intended: the alerts say "a stack is running, and this is what it has cost so far". Tear it
down when the test is done.

## Step 8. Create the GitHub environments

In GitHub, open the repository, then **Settings**, then **Environments**, then **New environment**:

| Environment | Required reviewers | Used by |
|---|---|---|
| `infra-staging` | you | `velza-staging-gha-tf-apply` (terraform apply, staging root) |
| `infra-prod` | you (and later, not the PR author) | `velza-prod-gha-tf-apply` (terraform apply, prod root) |
| `build` | none | `velza-gha-build` (image build and push to ECR, Phase 8) |
| `staging` | none | `velza-staging-gha-deploy` (Phase 8 release) |
| `production` | the release approvers | `velza-prod-gha-deploy` (Phase 8 release) |

For **every one of these five environments**, under **Deployment branches and tags**, choose **Selected branches and
tags** and add only `main`. This matters for `build` in particular: AWS trusts the `build` environment, so the branch
rule is what makes sure only code on `main` can push images. Other events on `main` (such as `pull_request_target`)
can't use the role unless the job is in the `build` environment.

## Step 9. The first apply: prod first, then staging

The GitHub workflow that runs applies (`infra-apply.yml`) is built in **Phase 8**. Until then, GitHub can only plan,
and **you run the first applies yourself** from your laptop with your own admin sign-in. Agents never do this.

1. `.\infra\aws\scripts\init.ps1 prod`
2. `terraform -chdir=infra/aws/live/prod plan -out="$env:TEMP\velza-prod.tfplan"`

   The saved plan goes **outside the repository** (your Windows temp folder). A plan file holds resource values and can
   hold secrets: **never commit it** (`.gitignore` also blocks `*.tfplan`). Delete it after the apply.
3. Read the plan. You should see:
   - **2 imports**: the state bucket and `velza-prod-gha-tf-apply`
   - new resources: the bucket settings, the boundary, roles `velza-prod-gha-tf-plan` and `velza-prod-gha-deploy`,
     the budget `velza-demo-account-monthly`, and the anomaly monitor and subscription
   - **nothing to destroy**
4. `terraform -chdir=infra/aws/live/prod apply "$env:TEMP\velza-prod.tfplan"`, then
   `Remove-Item "$env:TEMP\velza-prod.tfplan"`
5. Do the same for staging with `init.ps1 staging` and `velza-staging.tfplan`. Its plan should show **1 import** (its apply role), the staging
   roles and `velza-gha-build`, and **no budget and no anomaly monitor**.

## Step 10. After the first apply

1. **Budget**: in Billing and Cost Management, click **Budgets**. Check there is exactly one budget,
   `velza-demo-account-monthly`, with a $90.00 limit and 4 alerts (actual > $30, > $60, > $90, forecasted > $90).
   Budget emails need no confirmation click, but add the AWS sender to your safe list so the alerts don't land in spam.
2. **Anomaly Detection**: in **Cost Anomaly Detection**, check there is one monitor, `velza-account-services`, with a
   daily email alert subscription. If AWS sent you a confirmation email, click the link in it.
3. **Cost allocation tag**: in Billing and Cost Management, click **Cost allocation tags**, then **User-defined cost
   allocation tags**. Tick **`env`** (and `project`) and click **Activate**. The tag can take up to 24 hours to appear
   after the first apply. From then on, Cost Explorer can split the bill into staging and prod.
4. **GitHub variables**: run `terraform -chdir=infra/aws/live/<env> output role_arns`. Put the ARNs into the matching
   GitHub environments as variables (the Phase 8 workflows say which names).

Done. From here on, every infrastructure change is a pull request. The plan is shown on the PR, and the apply runs only
after you approve it in `infra-staging` / `infra-prod`. The exceptions, which you apply by hand with your admin
sign-in: changes to the permissions boundary, changes to an apply role's trust policy, and the final teardown.
