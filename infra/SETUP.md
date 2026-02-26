# Infrastructure Setup

This guide walks through provisioning the EKS Auto Mode cluster and enabling the kro and Argo CD managed capabilities — all via Terraform.

## Prerequisites

- AWS CLI v2.12.3+ configured with credentials that can create EKS clusters and IAM roles
- Terraform >= 1.3
- kubectl

## Step 1: Deploy Everything

Terraform creates:
- A VPC with public/private subnets and a NAT gateway
- An EKS Auto Mode cluster (compute fully managed by AWS — no node groups to configure)
- kro managed capability with IAM role
- Argo CD managed capability with IAM role

```bash
cd infra
terraform init
terraform plan
terraform apply
```

This takes ~15-20 minutes. The EKS capability module handles IAM role creation, trust policies, and capability provisioning automatically.

## Step 2: Configure kubectl

```bash
aws eks update-kubeconfig \
  --region $(terraform output -raw region) \
  --name $(terraform output -raw cluster_name)
```

## Step 3: Verify

```bash
# Check cluster access
kubectl get nodes

# Check kro CRDs are available
kubectl api-resources | grep kro.run

# Check Argo CD CRDs are available
kubectl api-resources | grep argoproj.io
```

## Teardown

```bash
cd infra
terraform destroy
```
