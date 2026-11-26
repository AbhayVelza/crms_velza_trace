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
