#!/usr/bin/env bash
# Enable kro and Argo CD managed capabilities on the EKS cluster.
# Run this AFTER terraform apply completes.
set -euo pipefail

REGION=$(terraform -chdir=infra output -raw region)
CLUSTER=$(terraform -chdir=infra output -raw cluster_name)
KRO_ROLE_ARN=$(terraform -chdir=infra output -raw kro_role_arn)
ARGOCD_ROLE_ARN=$(terraform -chdir=infra output -raw argocd_role_arn)

echo "==> Updating kubeconfig..."
aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER"

# --- kro capability ---
echo "==> Creating kro capability..."
aws eks create-capability \
  --region "$REGION" \
  --cluster-name "$CLUSTER" \
  --capability-name krombat-kro \
  --type KRO \
  --role-arn "$KRO_ROLE_ARN" \
  --delete-propagation-policy RETAIN

echo "==> Waiting for kro capability to become ACTIVE..."
while true; do
  STATUS=$(aws eks describe-capability \
    --region "$REGION" \
    --cluster-name "$CLUSTER" \
    --capability-name krombat-kro \
    --query 'capability.status' --output text)
  echo "    kro status: $STATUS"
  [ "$STATUS" = "ACTIVE" ] && break
  sleep 10
done

# Grant kro cluster-admin so it can manage all resource types in RGDs
echo "==> Granting kro cluster-admin permissions..."
aws eks associate-access-policy \
  --region "$REGION" \
  --cluster-name "$CLUSTER" \
  --principal-arn "$KRO_ROLE_ARN" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster

# --- Argo CD capability ---
echo "==> Creating Argo CD capability..."
aws eks create-capability \
  --region "$REGION" \
  --cluster-name "$CLUSTER" \
  --capability-name krombat-argocd \
  --type ARGOCD \
  --role-arn "$ARGOCD_ROLE_ARN" \
  --delete-propagation-policy RETAIN

echo "==> Waiting for Argo CD capability to become ACTIVE..."
while true; do
  STATUS=$(aws eks describe-capability \
    --region "$REGION" \
    --cluster-name "$CLUSTER" \
    --capability-name krombat-argocd \
    --query 'capability.status' --output text)
  echo "    argocd status: $STATUS"
  [ "$STATUS" = "ACTIVE" ] && break
  sleep 10
done

# Grant Argo CD cluster-admin so it can deploy all resource types
echo "==> Granting Argo CD cluster-admin permissions..."
aws eks associate-access-policy \
  --region "$REGION" \
  --cluster-name "$CLUSTER" \
  --principal-arn "$ARGOCD_ROLE_ARN" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster

echo ""
echo "==> Done! Verifying capabilities..."
kubectl api-resources | grep -E "kro.run|argoproj.io" || true
echo ""
echo "Cluster is ready. Next: configure Argo CD repo access and create an Application."
