#!/usr/bin/env bash
# Shared test helpers
set -euo pipefail

# CRITICAL: Always use the krombat cluster context. Multiple EKS clusters share
# this kubeconfig — another session may switch the default context at any time.
KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-arn:aws:eks:us-west-2:319279230668:cluster/krombat}"
export KUBECTL_CONTEXT
kctl() { kubectl --context "$KUBECTL_CONTEXT" "$@"; }

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
    "kctl get dungeon $name -o jsonpath='{.status.livingMonsters}' 2>/dev/null | grep -qE '[0-9]+'" 60
}

# After #110: combat is processed synchronously by the Go backend via REST API.
# Attacks must be submitted via backend API — direct Attack CR apply does nothing.
# BACKEND_URL is set by each test or defaults to port-forwarded backend.
BACKEND_URL="${BACKEND_URL:-http://localhost:8089}"

# Setup port-forward for backend if not already running on BACKEND_URL port
# Call once per test group; stores PF_PID for cleanup
INTEGRATION_PF_PID=""
setup_backend_pf() {
  local port="${1:-8089}"
  # If BACKEND_URL is already set to a non-localhost URL (e.g. prod), use it as-is.
  # Only set up a port-forward if BACKEND_URL is unset or points to localhost.
  if echo "${BACKEND_URL:-}" | grep -q "localhost"; then
    BACKEND_URL="http://localhost:${port}"
    if ! curl -s --max-time 3 "${BACKEND_URL}/healthz" &>/dev/null; then
      kctl port-forward svc/rpg-backend -n rpg-system "${port}:8080" > /dev/null 2>&1 &
      INTEGRATION_PF_PID=$!
      for i in $(seq 1 15); do
        sleep 1
        if curl -s --max-time 2 "${BACKEND_URL}/healthz" &>/dev/null; then break; fi
      done
    fi
  fi
}
teardown_backend_pf() {
  [ -n "${INTEGRATION_PF_PID:-}" ] && kill "$INTEGRATION_PF_PID" 2>/dev/null || true
}

# Submit an attack via the backend REST API and wait for attackSeq to increment
# AND for kro to finish processing all triggers:
# - lastAttackTarget cleared by combatResolve (normal combat + backstab)
# - lastAbility cleared by abilityResolve (mage heal, warrior taunt)
# Usage: submit_attack <dungeon-name> <target> [damage]
submit_attack() {
  local dname="$1" target="$2" damage="${3:-0}"
  local prev_seq
  prev_seq=$(kctl get dungeon "$dname" -o jsonpath='{.spec.attackSeq}' 2>/dev/null || echo "0")
  curl -s -X POST "${BACKEND_URL}/api/v1/dungeons/default/${dname}/attacks" \
    -H "Content-Type: application/json" \
    -d "{\"target\":\"${target}\",\"damage\":${damage},\"seq\":${prev_seq}}" -o /dev/null
  # Wait for attackSeq to increment (backend wrote triggers)
  wait_for "${dname} attackSeq > ${prev_seq}" \
    "[ \$(kctl get dungeon ${dname} -o jsonpath='{.spec.attackSeq}' 2>/dev/null || echo 0) -gt ${prev_seq} ]" 30
  # Wait for kro to finish — both combatResolve (clears lastAttackTarget) and abilityResolve (clears lastAbility)
  wait_for "${dname} kro resolved" \
    "[ -z \"\$(kctl get dungeon ${dname} -o jsonpath='{.spec.lastAttackTarget}' 2>/dev/null)\" ] && [ -z \"\$(kctl get dungeon ${dname} -o jsonpath='{.spec.lastAbility}' 2>/dev/null)\" ]" 30
}

# Submit an action (non-combat) via the backend REST API and wait for kro to finish.
# The backend writes trigger fields (lastAction, actionSeq) and kro's actionResolve
# specPatch computes the actual state mutations, then clears lastAction.
# Usage: submit_action <dungeon-name> <action>
submit_action() {
  local dname="$1" action="$2"
  local prev_seq
  prev_seq=$(kctl get dungeon "$dname" -o jsonpath='{.spec.actionSeq}' 2>/dev/null || echo "0")
  curl -s -X POST "${BACKEND_URL}/api/v1/dungeons/default/${dname}/attacks" \
    -H "Content-Type: application/json" \
    -d "{\"target\":\"${action}\",\"damage\":0,\"seq\":${prev_seq}}" -o /dev/null
  # Wait for actionSeq > prevSeq (backend wrote triggers) AND lastAction == '' (kro finished)
  wait_for "${dname} action processed" \
    "[ \"\$(kctl get dungeon ${dname} -o jsonpath='{.spec.actionSeq}' 2>/dev/null)\" -gt \"${prev_seq}\" ] && [ -z \"\$(kctl get dungeon ${dname} -o jsonpath='{.spec.lastAction}' 2>/dev/null)\" ]" 30
}
