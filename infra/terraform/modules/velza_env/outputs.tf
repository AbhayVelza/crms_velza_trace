output "static_ip" {
  description = "Point the domain's DNS A record here."
  value       = aws_lightsail_static_ip.app.ip_address
}

output "instance_name" {
  value = aws_lightsail_instance.app.name
}

output "database_endpoint" {
  description = "Managed database host (prod); null on staging, which runs its database in a container."
  value       = var.create_database ? aws_lightsail_database.main[0].master_endpoint_address : null
}

output "backup_bucket" {
  value = aws_lightsail_bucket.backups.name
}

output "parameter_path" {
  description = "Every runtime setting lives under this Parameter Store path."
  value       = local.param
}
