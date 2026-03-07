#!/usr/bin/env bash
# Full validation: integration, guardrails, backend API, UI smoke, all journeys
set -uo pipefail
cd "$(dirname "$0")/.."
DIR="tests"

FAILED=0

run() {
  echo ""
  echo "========================================="
  echo "  $1"
  echo "========================================="
  shift
  "$@" 2>&1
  [ $? -ne 0 ] && FAILED=1
}

ensure_port_forward() {
  local svc=$1 port=$2 pid_var=$3
  lsof -ti:$port | xargs kill -9 2>/dev/null
  kubectl port-forward svc/$svc -n rpg-system $port:$port > /dev/null 2>&1 &
  eval "$pid_var=$!"
  sleep 3
}

cleanup() {
  kill $PF_BACKEND $PF_FRONTEND 2>/dev/null
  lsof -ti:3000 -ti:8080 | xargs kill -9 2>/dev/null
}
trap cleanup EXIT

# 1. Integration tests
run "INTEGRATION TESTS" "$DIR/run.sh"

# 2. Guardrail tests
run "GUARDRAIL TESTS" "$DIR/guardrails.sh"

# 3. Backend API tests
ensure_port_forward rpg-backend 8080 PF_BACKEND
run "BACKEND API TESTS" "$DIR/backend-api.sh"

# 4. UI smoke + journeys need frontend port-forward
ensure_port_forward rpg-frontend 3000 PF_FRONTEND

if command -v npx &>/dev/null && npx playwright --version &>/dev/null 2>&1; then
  run "UI SMOKE TESTS" node "$DIR/e2e/smoke-test.js"

  # Run all journeys in parallel
  JOURNEY_PIDS=()
  JOURNEY_LOGS=()
  JOURNEY_NAMES=()
  for j in "$DIR"/e2e/journeys/*.js; do
    name=$(basename "$j" .js)
    log=$(mktemp)
    node "$j" > "$log" 2>&1 &
    JOURNEY_PIDS+=($!)
    JOURNEY_LOGS+=("$log")
    JOURNEY_NAMES+=("$name")
  done

  echo ""
  echo "========================================="
  echo "  JOURNEYS (${#JOURNEY_PIDS[@]} running in parallel)"
  echo "========================================="

  for i in "${!JOURNEY_PIDS[@]}"; do
    wait "${JOURNEY_PIDS[$i]}"
    rc=$?
    echo ""
    echo "--- ${JOURNEY_NAMES[$i]} ---"
    cat "${JOURNEY_LOGS[$i]}"
    rm -f "${JOURNEY_LOGS[$i]}"
    [ $rc -ne 0 ] && FAILED=1
  done
else
  echo ""
  echo "⚠️  Playwright not installed — skipping UI + journey tests"
  echo "  Install: npx playwright install chromium"
fi

echo ""
echo "========================================="
if [ $FAILED -ne 0 ]; then
  echo "  ❌ VALIDATION FAILED"
else
  echo "  ✅ ALL SUITES PASSED"
fi
echo "========================================="
exit $FAILED
