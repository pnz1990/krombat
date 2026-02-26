# Infrastructure Setup

This guide walks through provisioning the EKS Auto Mode cluster and enabling the kro and Argo CD managed capabilities — all via Terraform.

## Prerequisites

- AWS CLI v2.12.3+ configured with credentials
- Terraform >= 1.3
- kubectl

## What Terraform Creates

- VPC with public/private subnets and NAT gateway
- EKS Auto Mode cluster (K8s 1.34, compute managed by AWS)
- kro managed capability with IAM role
- Argo CD managed capability with IAM role + Identity Center integration
- ECR repository (`krombat/backend`) with lifecycle policy
- GitHub Actions OIDC federation for CI (IAM role + EKS access entry)

## Step 1: Deploy

```bash
cd infra
terraform init
terraform plan
terraform apply
```

Takes ~15-20 minutes.

## Step 2: Post-Terraform Setup

These manual steps are needed after Terraform:

```bash
# Configure kubectl
aws eks update-kubeconfig \
  --region $(terraform output -raw region) \
  --name $(terraform output -raw cluster_name)

# Grant kro cluster-admin (needed to create Pods, Namespaces, etc. from RGDs)
KRO_ROLE=$(terraform state show 'module.kro.aws_iam_role.this[0]' | grep "arn " | awk '{print $3}' | tr -d '"')
aws eks associate-access-policy --region us-west-2 --cluster-name krombat \
  --principal-arn "$KRO_ROLE" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster

# Grant Argo CD cluster-admin
ARGOCD_ROLE=$(terraform state show 'module.argocd.aws_iam_role.this[0]' | grep "arn " | awk '{print $3}' | tr -d '"')
aws eks associate-access-policy --region us-west-2 --cluster-name krombat \
  --principal-arn "$ARGOCD_ROLE" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster

# Register local cluster for Argo CD
CLUSTER_ARN=$(aws eks describe-cluster --name krombat --region us-west-2 --query 'cluster.arn' --output text)
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: local-cluster
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
stringData:
  name: in-cluster
  server: "$CLUSTER_ARN"
  project: default
EOF

# Bootstrap Argo CD Application
kubectl apply -f manifests/apps/argocd-app.yaml

# Set GitHub Actions secret
gh secret set AWS_ROLE_ARN --body "$(terraform output -raw github_actions_role_arn)"
```

## Step 3: Configure Argo CD Webhook (optional, for fast sync)

1. Generate secret: `openssl rand -hex 20`
2. Store in cluster: `kubectl patch secret argocd-webhook-creds-secret -n argocd --type merge -p '{"stringData":{"webhook.github.secret":"<secret>"}}'`
3. Add GitHub webhook: `https://<argocd-server-url>/api/webhook` with push events

## Step 4: Verify

```bash
kubectl get rgd                          # Both RGDs should be Active
kubectl get application krombat -n argocd # Should be Synced
kubectl get pods -n rpg-system           # Backend should be Running
./tests/run.sh                           # 27 game engine tests
./tests/backend-api.sh                   # 14 API tests (needs port-forward)
```

## Teardown

```bash
cd infra
terraform destroy
```
