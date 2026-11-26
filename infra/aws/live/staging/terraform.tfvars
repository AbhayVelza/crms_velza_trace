# velza-staging — THE ONE FILE that differs between the demo account and the company account.
# Everything that changes on the move (account ID, region, domain, protect, budget, alert email, who owns the
# account-wide things) is here and nowhere else. No secrets in this file: it is committed.
# Placeholders (000000000000, CHANGE_ME@example.com) are rejected by validation, so fill them in before a plan.
# Pass bucket/region to the backend with infra/aws/scripts/init.ps1 (or init.sh) staging.

account_id = "138893339714"                 # demo AWS account ID (12 digits)
region     = "ap-south-1"                   # Mumbai
domain     = "staging.demo.velzaglobal.com" # test subdomain (Q2), used from Phase 5
protect    = false                          # demo: false so terraform destroy removes everything; company: true

# Account-wide things (state bucket, the ONE budget, the Cost Anomaly monitor) exist once per AWS account.
#   Demo (one shared account): false here — the PROD root owns them. Staging creates NO budget and NO anomaly monitor;
#     the single account budget in the prod root already covers staging's spend (no env filter).
#   Company account (staging has its own account): set true here.
manage_account_resources = false

# Budget values below are NOT used while manage_account_resources = false. They are kept for the company account,
# where this root gets its own account budget (amounts per docs/GO_LIVE_ARCHITECTURE.md section 4).
budget_name           = "velza-staging-account-monthly"
budget_thresholds_usd = [30, 60, 90] # USD per month, tax included (GST on AISPL)
anomaly_threshold_usd = 5
alert_email           = "claude.kailash@velzaglobal.com"

github_repo  = "AbhayVelza/crms_velza_trace"
state_bucket = "velza-tfstate-138893339714" # velza-tfstate-<account_id>

# ---- Phase 3 network (docs/GO_LIVE_ARCHITECTURE.md section 3)
# vpc_cidr: prod 10.40.0.0/16, staging 10.41.0.0/16. They must not overlap (in the demo account both VPCs sit side by
#   side). Keep the same values in the company account.
# az_ids: AZ IDs, not names. ap-south-1a/b/c map to different physical zones in each account; aps1-az1/2/3 do not.
#   Check which IDs the account has and that the sizes we need are offered there (README, Phase 3).
vpc_cidr = "10.41.0.0/16"
az_ids   = ["aps1-az1", "aps1-az3"]
