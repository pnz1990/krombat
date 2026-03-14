terraform {
  required_version = ">= 1.3.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.28.0"
    }
  }

  backend "s3" {
    bucket  = "krombat-terraform-state-319279230668"
    key     = "krombat/terraform.tfstate"
    region  = "us-west-2"
    profile = "319279230668-Admin"
  }
}

provider "aws" {
  region = var.region
}

# Identity Center lives in us-east-2 (org-level)
provider "aws" {
  alias  = "idc"
  region = var.idc_region
}

data "aws_availability_zones" "available" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

# --- VPC ---

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = "${var.cluster_name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = local.azs
  private_subnets = [for k, v in local.azs : cidrsubnet("10.0.0.0/16", 4, k)]
  public_subnets  = [for k, v in local.azs : cidrsubnet("10.0.0.0/16", 8, k + 48)]

  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true

  public_subnet_tags = {
    "kubernetes.io/role/elb" = 1
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = 1
  }
}

# --- EKS Auto Mode ---

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = var.cluster_name
  kubernetes_version = var.cluster_version

  endpoint_public_access = true

  enable_cluster_creator_admin_permissions = true

  compute_config = {
    enabled    = true
    node_pools = ["general-purpose", "system"]
  }

  # Observability
  addons = {
    amazon-cloudwatch-observability = {
      most_recent              = true
      service_account_role_arn = aws_iam_role.cloudwatch_agent.arn
      pod_identity_association = [{
        role_arn        = aws_iam_role.cloudwatch_agent.arn
        service_account = "cloudwatch-agent"
      }]
    }
    external-dns = {
      most_recent = true
      configuration_values = jsonencode({
        domainFilters = ["learn-kro.eks.aws.dev"]
      })
      pod_identity_association = [{
        role_arn        = aws_iam_role.external_dns.arn
        service_account = "external-dns"
      }]
    }
  }

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
}

# --- Identity Center ---

data "aws_ssoadmin_instances" "this" {
  count    = var.enable_idc ? 1 : 0
  provider = aws.idc
}

data "aws_identitystore_user" "admin" {
  count             = var.enable_idc ? 1 : 0
  provider          = aws.idc
  identity_store_id = one(data.aws_ssoadmin_instances.this[0].identity_store_ids)

  alternate_identifier {
    unique_attribute {
      attribute_path  = "UserName"
      attribute_value = "rrroizma"
    }
  }
}

# --- EKS Capabilities ---

module "argocd" {
  source = "terraform-aws-modules/eks/aws//modules/capability"

  type         = "ARGOCD"
  cluster_name = module.eks.cluster_name

  configuration = var.enable_idc ? {
    argo_cd = {
      aws_idc = {
        idc_instance_arn = one(data.aws_ssoadmin_instances.this[*].arns[0])
        idc_region       = var.idc_region
      }
      namespace = "argocd"
      rbac_role_mapping = [{
        role = "ADMIN"
        identity = [{
          id   = one(data.aws_identitystore_user.admin[*].user_id)
          type = "SSO_USER"
        }]
      }]
    }
  } : {}
}
