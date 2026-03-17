#!/usr/bin/env bash
# Creates (or rotates) the krombat-test-auth Kubernetes Secret used by test scripts
# to authenticate against the backend API test bypass.
#
# The KROMBAT_TEST_USER value is a cryptographically random hex string — never
# committed to git.  Only users with kubectl access to the cluster can read it.
#
# Run once before running any test suite:
#   bash tests/create-test-secret.sh
#
# To rotate the token:
#   bash tests/create-test-secret.sh --rotate
set -euo pipefail

# Load .env from the repo root if present (provides AWS_ACCOUNT_ID locally).
_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$_REPO_ROOT/.env" ]; then
  # shellcheck source=/dev/null
  set -a; source "$_REPO_ROOT/.env"; set +a
fi
if [ -z "${AWS_ACCOUNT_ID:-}" ]; then
  echo "ERROR: AWS_ACCOUNT_ID is not set. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-arn:aws:eks:us-west-2:${AWS_ACCOUNT_ID}:cluster/krombat}"
kctl() { kubectl --context "$KUBECTL_CONTEXT" "$@"; }

ROTATE="${1:-}"
EXISTING=$(kctl get secret krombat-test-auth -n rpg-system --ignore-not-found 2>/dev/null || true)

if [ -n "$EXISTING" ] && [ "$ROTATE" != "--rotate" ]; then
  echo "krombat-test-auth already exists (pass --rotate to regenerate)"
  exit 0
fi

TOKEN="$(openssl rand -hex 31)"  # 62 chars — Kubernetes label values must be ≤63 characters

kctl create secret generic krombat-test-auth \
  --namespace rpg-system \
  --from-literal=KROMBAT_TEST_USER="$TOKEN" \
  --dry-run=client -o yaml | kctl apply -f -

echo "krombat-test-auth secret created/updated with a random token."
echo "Restart backend pods so the new value takes effect:"
echo "  kubectl --context $KUBECTL_CONTEXT rollout restart deployment/rpg-backend -n rpg-system"
