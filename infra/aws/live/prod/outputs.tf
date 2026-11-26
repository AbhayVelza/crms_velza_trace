output "role_arns" {
  description = "GitHub Actions role ARNs: put them into the matching GitHub environment variables."
  value       = module.ci_access.role_arns
}

output "boundary_arn" {
  value = module.ci_access.boundary_arn
}

output "state_bucket" {
  value = var.manage_account_resources ? module.state[0].bucket_name : null
}

output "budget_name" {
  value = var.manage_account_resources ? module.budgets[0].budget_name : null
}

# ---- Phase 3 network, used by Phase 4 (data) and Phase 5 (app)

output "vpc_id" {
  value = module.network.vpc_id
}

output "subnet_ids" {
  description = "Subnet IDs by tier (public, private_app, db), in az_ids order."
  value       = module.network.subnet_ids
}

output "security_group_ids" {
  description = "Security group IDs: alb, app, task, db."
  value       = module.network.security_group_ids
}

output "db_subnet_group_name" {
  value = module.network.db_subnet_group_name
}

output "s3_endpoint_id" {
  value = module.network.s3_endpoint_id
}

# ---- FAST TRACK (docs/golive/FAST_TRACK.md)

output "app_url" {
  description = "Open this in a browser (plain HTTP on the ALB DNS name until Phase 5 adds the domain and HTTPS)."
  value       = module.app.app_url
}

output "ecr_repository_urls" {
  value = module.registry.repository_urls
}

output "ecs_cluster" {
  value = module.app.cluster_name
}

output "ecs_service" {
  value = module.app.service_name
}

output "app_log_group" {
  value = module.app.log_group_name
}

output "db_address" {
  value = module.data.address
}

output "db_master_secret_arn" {
  description = "RDS-managed secret of the master user (value never in the state)."
  value       = module.data.master_user_secret_arn
}
