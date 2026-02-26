output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "region" {
  value = var.region
}

output "kro_role_arn" {
  value = aws_iam_role.kro_capability.arn
}

output "argocd_role_arn" {
  value = aws_iam_role.argocd_capability.arn
}
