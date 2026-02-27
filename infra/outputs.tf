output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "region" {
  value = var.region
}

output "kro_capability_arn" {
  value = module.kro.arn
}

output "argocd_capability_arn" {
  value = module.argocd.arn
}

output "github_actions_role_arn" {
  value = var.enable_ci ? aws_iam_role.github_actions[0].arn : ""
}

output "ecr_backend_url" {
  value = var.enable_ecr ? aws_ecr_repository.backend[0].repository_url : ""
}

output "cloudwatch_log_group_rpg" {
  value = aws_cloudwatch_log_group.rpg_system.name
}

output "cloudwatch_dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${var.cluster_name}-game"
}
