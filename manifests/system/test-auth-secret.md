# krombat-test-auth Secret — NOT committed with real values.
#
# This Secret supplies KROMBAT_TEST_USER to the backend pod, enabling the
# integration-test auth bypass.  The value must be a cryptographically random
# hex string — NEVER a static value like "test-player".
#
# Create/rotate via the helper script (requires kubectl cluster access):
#
#   bash tests/create-test-secret.sh           # create
#   bash tests/create-test-secret.sh --rotate  # rotate
#
# After rotating, restart the backend to pick up the new value:
#
#   kubectl --context arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat \
#     rollout restart deployment/rpg-backend -n rpg-system
#
# Test scripts (helpers.sh, backend-api.sh, guardrails.sh) read this secret
# at runtime via kubectl — the token value is never hardcoded in source files.
#
# This file is intentionally empty of real secrets.
# Argo CD will NOT apply this file — it has no actual K8s resource.
# The secret must be created out-of-band using the helper script above.
