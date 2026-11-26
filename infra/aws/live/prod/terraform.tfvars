# velza-prod — THE ONE FILE that differs between the demo account and the company account.
# Everything that changes on the move (account ID, regions, domain, protect, budget, alert email, who owns the
# account-wide things) is here and nowhere else. No secrets in this file: it is committed.
# Placeholders (000000000000, CHANGE_ME@example.com) are rejected by validation, so fill them in before a plan.
# Pass bucket/region to the backend with infra/aws/scripts/init.ps1 (or init.sh) prod.

account_id = "000000000000"         # demo AWS account ID (12 digits)
region     = "ap-south-1"           # Mumbai
dr_region  = "ap-south-2"           # Hyderabad (DR, Phase 4)
domain     = "demo.velzaglobal.com" # test subdomain (Q2), used from Phase 5; company: app.velzaglobal.com
protect    = false                  # demo: false so terraform destroy removes everything; company: true

# Account-wide things (state bucket, the ONE budget, the Cost Anomaly monitor) exist once per AWS account.
#   Demo (one shared account): true here, false in staging. So there is exactly ONE budget for the WHOLE demo
#     account, with no env filter: it counts staging + prod + anything else in the account.
#   Company account (separate accounts): true in both roots, one budget per account.
manage_account_resources = true

# The ONE demo-account budget: $30 / $60 / $90 a month, tax included (AWS Budgets counts tax; on AISPL that is GST).
# Email on ACTUAL spend above each threshold + FORECASTED spend above $90. Company account: real amounts from
# docs/GO_LIVE_ARCHITECTURE.md section 4 and a new name, e.g. velza-prod-account-monthly.
budget_name           = "velza-demo-account-monthly"
budget_thresholds_usd = [30, 60, 90]
anomaly_threshold_usd = 5 # USD of impact before an anomaly email is sent
alert_email           = "CHANGE_ME@example.com"

github_repo  = "AbhayVelza/crms_velza_trace"
state_bucket = "velza-tfstate-000000000000" # velza-tfstate-<account_id>
