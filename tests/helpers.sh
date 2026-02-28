#!/usr/bin/env bash
# Shared test helpers
set -euo pipefail

PASS=0; FAIL=0; TESTS=()
log()  { echo "=== $1"; }
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); TESTS+=("PASS: $1"); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); TESTS+=("FAIL: $1"); }
wait_for() {
  local desc="$1" cmd="$2" timeout="${3:-30}"
  for i in $(seq 1 "$timeout"); do
    if eval "$cmd" &>/dev/null; then return 0; fi
    sleep 1
  done
  echo "  ⏰ Timed out waiting for: $desc"
  return 1
}
summary() {
  echo ""
  echo "========================================"
  echo "  $1: $PASS passed, $FAIL failed"
  echo "========================================"
  for t in "${TESTS[@]}"; do echo "  $t"; done
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
}
wait_dungeon_ready() {
  local name="$1"
  wait_for "$name ready" \
    "kubectl get dungeon $name -o jsonpath='{.status.livingMonsters}' 2>/dev/null | grep -qE '[0-9]+'" 60
}
wait_job() {
  local name="$1"
  wait_for "$name complete" \
    "kubectl get job $name -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60
}
