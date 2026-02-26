variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "krombat"
}

variable "cluster_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.34"
}

variable "idc_region" {
  description = "AWS region where Identity Center is configured"
  type        = string
  default     = "us-west-2"
}

variable "enable_ci" {
  description = "Enable GitHub Actions OIDC federation for CI"
  type        = bool
  default     = true
}

variable "github_repo" {
  description = "GitHub repo in owner/name format"
  type        = string
  default     = "pnz1990/krombat"
}
