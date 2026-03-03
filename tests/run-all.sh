#!/usr/bin/env bash
# Full test suite: integration, guardrails, backend API, UI smoke tests
set -uo pipefail
DIR="$(dirname "$0")"
cd "$(dirname "$DIR")"

TOTAL_PASS=0
TOTAL_FAIL=0

run_suite() {
  local name="$1" cmd="$2"
  echo ""
  echo "========================================="
  echo "  $name"
  echo "========================================="
  eval "$cmd"
  local rc=$?
  return $rc
}

# 1. Integration tests
run_suite "INTEGRATION TESTS" "$DIR/run.sh 2>&1"
echo ""

# 2. Guardrail tests
run_suite "GUARDRAIL TESTS" "$DIR/guardrails.sh 2>&1"
echo ""

# 3. Backend API tests (via port-forward)
echo "========================================="
echo "  BACKEND API TESTS"
echo "========================================="
lsof -ti:8080 | xargs kill -9 2>/dev/null
kubectl port-forward svc/rpg-backend -n rpg-system 8080:8080 > /dev/null 2>&1 &
PF_BACKEND=$!
sleep 3
$DIR/backend-api.sh 2>&1
kill $PF_BACKEND 2>/dev/null
echo ""

# 4. UI smoke tests (via port-forward)
echo "========================================="
echo "  UI SMOKE TESTS"
echo "========================================="
lsof -ti:3000 | xargs kill -9 2>/dev/null
kubectl port-forward svc/rpg-frontend -n rpg-system 3000:3000 > /dev/null 2>&1 &
PF_FRONTEND=$!
sleep 3
if command -v npx &>/dev/null && npx playwright --version &>/dev/null 2>&1; then
  node $DIR/e2e/smoke-test.js 2>&1
else
  echo "  ⚠️  Playwright not installed — skipping UI tests"
  echo "  Install: npx playwright install chromium"
fi
kill $PF_FRONTEND 2>/dev/null
lsof -ti:3000 | xargs kill -9 2>/dev/null
echo ""

echo "========================================="
echo "  ALL SUITES COMPLETE"
echo "========================================="
