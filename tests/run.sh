#!/usr/bin/env bash
# Parallel integration test runner
# Runs 4 test groups concurrently, waits for all, reports combined results
set -uo pipefail  # no -e: we handle failures from wait_group manually

DIR="$(dirname "$0")"
source "$DIR/helpers.sh"
chmod +x "$DIR"/test-core.sh "$DIR"/test-abilities.sh "$DIR"/test-features.sh "$DIR"/test-infra.sh "$DIR"/helpers.sh

echo "🧪 Running 4 test groups in parallel..."
echo ""

# Pre-flight: verify CRDs exist
echo "=== Pre-flight ==="
for i in $(seq 1 90); do
  if kctl get crd dungeons.game.k8s.example &>/dev/null && kctl get crd attacks.game.k8s.example &>/dev/null; then
    echo "  ✅ CRDs available"
    break
  fi
  sleep 1
done

# Run all 4 groups in parallel
"$DIR"/test-core.sh      > /tmp/test-core.log 2>&1 &
PID_CORE=$!
"$DIR"/test-abilities.sh  > /tmp/test-abilities.log 2>&1 &
PID_ABILITIES=$!
"$DIR"/test-features.sh   > /tmp/test-features.log 2>&1 &
PID_FEATURES=$!
"$DIR"/test-infra.sh      > /tmp/test-infra.log 2>&1 &
PID_INFRA=$!

FAILED=0

wait_group() {
  local name=$1 pid=$2 log=$3
  if wait "$pid"; then
    echo "✅ $name PASSED"
  else
    echo "❌ $name FAILED"
    FAILED=$((FAILED + 1))
  fi
  # Print results summary from log
  grep -E "PASS:|FAIL:|Results" "$log" 2>/dev/null | tail -20
  echo ""
}

echo ""
echo "=== Waiting for test groups ==="
echo ""

wait_group "Core Lifecycle" $PID_CORE /tmp/test-core.log
wait_group "Abilities"      $PID_ABILITIES /tmp/test-abilities.log
wait_group "Features"       $PID_FEATURES /tmp/test-features.log
wait_group "Infra"          $PID_INFRA /tmp/test-infra.log

# Cleanup test dungeons only — scope to the test user's owner label.
# NEVER delete user dungeons owned by real GitHub logins.
echo "=== Cleanup ==="
kctl delete attacks --all --ignore-not-found --wait=false 2>/dev/null || true
_CLEANUP_USER="$(kubectl --context "${KUBECTL_CONTEXT:-arn:aws:eks:us-west-2:319279230668:cluster/krombat}" \
  get secret krombat-test-auth -n rpg-system \
  -o jsonpath='{.data.KROMBAT_TEST_USER}' 2>/dev/null | base64 -d || true)"
if [ -n "$_CLEANUP_USER" ]; then
  kctl delete dungeons -l "krombat.io/owner=${_CLEANUP_USER}" --ignore-not-found --wait=false 2>/dev/null || true
else
  echo "  Warning: could not resolve test user — skipping dungeon cleanup to protect user data"
fi

# Count totals
TOTAL_PASS=$(grep -rh "^  PASS:" /tmp/test-*.log 2>/dev/null | wc -l | tr -d ' ')
TOTAL_FAIL=$(grep -rh "^  FAIL:" /tmp/test-*.log 2>/dev/null | wc -l | tr -d ' ' || echo 0)

echo ""
echo "========================================"
echo "  TOTAL: $TOTAL_PASS passed, $TOTAL_FAIL failed ($FAILED groups failed)"
echo "========================================"

# Show any failures
if [ "$TOTAL_FAIL" -gt 0 ] 2>/dev/null; then
  echo ""
  echo "Failures:"
  grep -rh "^  FAIL:" /tmp/test-*.log 2>/dev/null || true
fi

[ "$FAILED" -eq 0 ] && exit 0 || exit 1
