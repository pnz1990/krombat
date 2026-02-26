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
