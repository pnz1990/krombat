# krombat-github-oauth Secret — NOT committed with real values.
# Create manually on the cluster before deploying:
#
#   kubectl -n rpg-system create secret generic krombat-github-oauth \
#     --from-literal=GITHUB_CLIENT_ID=<your-client-id> \
#     --from-literal=GITHUB_CLIENT_SECRET=<your-client-secret> \
#     --from-literal=SESSION_SECRET=$(openssl rand -hex 32)
#
# SESSION_SECRET must be the same value on all pods (it signs session cookies
# so any pod can verify them without a shared store).  Generate once and store
# in the secret — rotating it invalidates all existing sessions.
#
# The Secret is marked optional: true in the backend Deployment, so pods will
# still start without it (OAuth routes return 503 until the secret exists).
#
# To register a GitHub OAuth App:
#   Settings > Developer settings > OAuth Apps > New OAuth App
#   Homepage URL:       https://learn-kro.eks.aws.dev
#   Authorization callback URL: https://learn-kro.eks.aws.dev/api/v1/auth/callback
#
# This file is intentionally left empty of real secrets.
# Argo CD will NOT apply this file — it has no actual K8s resource.
# The secret must be created out-of-band (manually or via Terraform).
