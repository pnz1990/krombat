#!/usr/bin/env bash
# Parallel integration test runner
# Runs 4 test groups concurrently, waits for all, reports combined results
set -euo pipefail

DIR="$(dirname "$0")"
chmod +x "$DIR"/test-core.sh "$DIR"/test-abilities.sh "$DIR"/test-features.sh "$DIR"/test-infra.sh "$DIR"/helpers.sh

echo "🧪 Running 4 test groups in parallel..."
echo ""

# Pre-flight: verify CRDs exist
echo "=== Pre-flight ==="
for i in $(seq 1 90); do
  if kubectl get crd dungeons.game.k8s.example &>/dev/null && kubectl get crd attacks.game.k8s.example &>/dev/null; then
    echo "  ✅ CRDs available"
    break
  fi
  sleep 1
done

# Run all 4 groups in parallel (5-min timeout each)
run_with_timeout() {
  local name=$1 script=$2 log=$3
  "$script" > "$log" 2>&1 &
  local pid=$!
  ( sleep 300 && kill $pid 2>/dev/null && echo "  ⏰ $name timed out after 5min" >> "$log" ) &
  local timer=$!
  wait $pid 2>/dev/null
  local rc=$?
  kill $timer 2>/dev/null; wait $timer 2>/dev/null
  return $rc
}

run_with_timeout "Core"      "$DIR/test-core.sh"      /tmp/test-core.log &
PID_CORE=$!
run_with_timeout "Abilities"  "$DIR/test-abilities.sh"  /tmp/test-abilities.log &
PID_ABILITIES=$!
run_with_timeout "Features"   "$DIR/test-features.sh"   /tmp/test-features.log &
PID_FEATURES=$!
run_with_timeout "Infra"      "$DIR/test-infra.sh"      /tmp/test-infra.log &
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

# Cleanup all test dungeons
echo "=== Cleanup ==="
kubectl delete attacks --all --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete dungeons --all --ignore-not-found --wait=false 2>/dev/null || true

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
