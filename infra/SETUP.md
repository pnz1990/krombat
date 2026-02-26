# Infrastructure Setup

This guide walks through provisioning the EKS Auto Mode cluster and enabling the kro and Argo CD managed capabilities.

## Prerequisites

- AWS CLI v2.12.3+ configured with credentials that can create EKS clusters and IAM roles
- Terraform >= 1.3
- kubectl

## Step 1: Provision the EKS Cluster

Terraform creates:
- A VPC with public/private subnets and a NAT gateway
- An EKS Auto Mode cluster (compute managed by AWS — no node groups to configure)
- IAM roles for the kro and Argo CD capabilities

```bash
cd infra
terraform init
terraform plan
terraform apply
```

This takes ~10-15 minutes. When complete, Terraform outputs the cluster name, endpoint, region, and capability role ARNs.

## Step 2: Enable Managed Capabilities

The `aws_eks_capability` Terraform resource is not yet available in the AWS provider, so capabilities are enabled via a shell script that uses the AWS CLI.

From the project root:

```bash
./infra/enable-capabilities.sh
```

This script:
1. Updates your kubeconfig for the new cluster
2. Creates the **kro** capability and waits for it to become ACTIVE
3. Grants kro `AmazonEKSClusterAdminPolicy` so it can manage all Kubernetes resource types defined in RGDs
4. Creates the **Argo CD** capability and waits for it to become ACTIVE
5. Grants Argo CD `AmazonEKSClusterAdminPolicy` so it can deploy all resource types
6. Verifies that `ResourceGraphDefinition` and Argo CD CRDs are available

> **Note:** The Argo CD capability created here does not configure AWS Identity Center integration. If you need the Argo CD UI with SSO, add `--configuration` with your Identity Center details to the `create-capability` call in the script. For CLI/kubectl-only GitOps workflows, this is not required.

## Step 3: Verify

```bash
# Check cluster access
kubectl get nodes

# Check kro is ready
kubectl api-resources | grep kro.run

# Check Argo CD is ready
kubectl api-resources | grep argoproj.io

# List capabilities
aws eks list-capabilities --region $(terraform -chdir=infra output -raw region) --cluster-name $(terraform -chdir=infra output -raw cluster_name)
```

## Teardown

```bash
# Delete capabilities first
REGION=$(terraform -chdir=infra output -raw region)
CLUSTER=$(terraform -chdir=infra output -raw cluster_name)

aws eks delete-capability --region $REGION --cluster-name $CLUSTER --capability-name krombat-argocd
aws eks delete-capability --region $REGION --cluster-name $CLUSTER --capability-name krombat-kro

# Wait for deletions to complete, then destroy infrastructure
cd infra
terraform destroy
```
