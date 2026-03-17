variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "AWS CLI profile name (e.g. 123456789012-Admin). Set in terraform.tfvars — never committed."
  type        = string
}

variable "state_bucket" {
  description = "S3 bucket name for Terraform remote state. Set in terraform.tfvars — never committed."
  type        = string
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
  default     = "us-east-2"
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

variable "enable_ecr" {
  description = "Enable ECR repository creation"
  type        = bool
  default     = true
}
