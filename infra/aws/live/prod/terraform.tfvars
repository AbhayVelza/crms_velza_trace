# velza-prod — THE ONE FILE that differs between the demo account and the company account.
# Everything that changes on the move (account ID, regions, domain, protect, budget, alert email, who owns the
# account-wide things) is here and nowhere else. No secrets in this file: it is committed.
# Placeholders (000000000000, CHANGE_ME@example.com) are rejected by validation, so fill them in before a plan.
# Pass bucket/region to the backend with infra/aws/scripts/init.ps1 (or init.sh) prod.

account_id = "138893339714"         # demo AWS account ID (12 digits)
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
alert_email           = "claude.kailash@velzaglobal.com"

github_repo  = "AbhayVelza/crms_velza_trace"
state_bucket = "velza-tfstate-138893339714" # velza-tfstate-<account_id>

# ---- Phase 3 network (docs/GO_LIVE_ARCHITECTURE.md section 3)
# vpc_cidr: prod 10.40.0.0/16, staging 10.41.0.0/16. They must not overlap (in the demo account both VPCs sit side by
#   side). Keep the same values in the company account.
# az_ids: AZ IDs, not names. ap-south-1a/b/c map to different physical zones in each account; aps1-az1/2/3 do not.
#   Check which IDs the account has and that the sizes we need are offered there (README, Phase 3).
vpc_cidr = "10.40.0.0/16"
az_ids   = ["aps1-az1", "aps1-az3"]

# ---- FAST TRACK (docs/golive/FAST_TRACK.md): database and app at production sizes (Step 0 / D10 / D11)
db_engine_version            = "17"           # D1 (proposed)
db_instance_class            = "db.t4g.large" # D11
db_multi_az                  = true
db_allocated_storage_gib     = 200
db_max_allocated_storage_gib = 500
db_backup_retention_days     = 14
app_cpu                      = 1024 # 1 vCPU (D10)
app_memory_mib               = 2048 # 2 GB (D10)
# 1, not D10's 2, until C1 (photos on S3) and C8 (shared lockout) are built: today's app keeps sign-in lockout, rate
# limits and damage photos inside one task. FAST_TRACK.md explains.
app_desired_count  = 1
log_retention_days = 30
# "" until the first image is pushed (the service then runs 0 tasks). deploy/aws/roll-app.ps1 sets it.
app_image_tag = ""
