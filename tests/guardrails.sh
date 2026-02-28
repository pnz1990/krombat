#!/usr/bin/env bash
# Guardrail: Ensure backend ONLY interacts with kro-generated CRs
# This test prevents regression — the backend must never touch native K8s objects
set -euo pipefail

PASS=0
FAIL=0
TESTS=()

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); TESTS+=("PASS: $1"); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); TESTS+=("FAIL: $1"); }

BACKEND_DIR="$(cd "$(dirname "$0")/../backend" && pwd)"
RBAC_FILE="$(cd "$(dirname "$0")/../manifests/rbac" && pwd)/rbac.yaml"

echo "=== Guardrail: Backend only touches kro CRs ==="
echo ""

# --- Code guardrails ---

echo "--- Code checks ---"

# No kubernetes.Clientset usage
grep -rq "Clientset\|kubernetes.Interface\|kubernetes.NewForConfig" "$BACKEND_DIR/internal/" 2>/dev/null \
  && fail "Backend uses kubernetes.Clientset (must use dynamic client only)" \
  || pass "No kubernetes.Clientset usage"

# No CoreV1/BatchV1/AppsV1 typed client usage
grep -rq "CoreV1\|BatchV1\|AppsV1\|corev1\|batchv1\|appsv1" "$BACKEND_DIR/internal/" 2>/dev/null \
  && fail "Backend uses typed K8s clients (CoreV1/BatchV1/AppsV1)" \
  || pass "No typed K8s client usage"

# No direct pod/secret/job/namespace operations
grep -rq '\.Pods(\|\.Secrets(\|\.Jobs(\|\.Namespaces(\|\.ConfigMaps(' "$BACKEND_DIR/internal/" 2>/dev/null \
  && fail "Backend directly accesses Pods/Secrets/Jobs/Namespaces" \
  || pass "No direct native resource access"

# Only game.k8s.example GVRs defined
NON_GAME_GVR=$(grep -rn "GroupVersionResource{" "$BACKEND_DIR/internal/" 2>/dev/null | grep -v "game.k8s.example" || true)
[ -z "$NON_GAME_GVR" ] \
  && pass "All GVR definitions are game.k8s.example" \
  || fail "Non-game GVR found: $NON_GAME_GVR"

# Client struct only has Dynamic field
grep -q "Clientset" "$BACKEND_DIR/internal/k8s/client.go" 2>/dev/null \
  && fail "K8s client struct contains Clientset field" \
  || pass "K8s client only has Dynamic interface"

# --- RBAC guardrails ---

echo ""
echo "--- RBAC checks ---"

# Backend SA only has game.k8s.example permissions
BACKEND_RULES=$(sed -n '/name: rpg-backend$/,/^---/p' "$RBAC_FILE")
echo "$BACKEND_RULES" | grep -q 'apiGroups: \[game.k8s.example\]' \
  && pass "Backend ClusterRole limited to game.k8s.example" \
  || fail "Backend ClusterRole has non-game apiGroups"

# Backend SA has NO access to core API group
echo "$BACKEND_RULES" | grep -q 'apiGroups: \[""\]' \
  && fail "Backend ClusterRole has core API group access (pods, secrets, etc)" \
  || pass "Backend ClusterRole has no core API group access"

# Backend SA has NO access to batch API group
echo "$BACKEND_RULES" | grep -q 'apiGroups: \[batch\]' \
  && fail "Backend ClusterRole has batch API group access (jobs)" \
  || pass "Backend ClusterRole has no batch API group access"

# --- Live cluster guardrails ---

echo ""
echo "--- Live cluster checks ---"

# Verify the SA can access dungeons
RESULT=$(kubectl auth can-i get dungeons.game.k8s.example --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "yes" ] \
  && pass "rpg-backend-sa can get dungeons" \
  || fail "rpg-backend-sa cannot get dungeons"

# Verify the SA CANNOT access pods
RESULT=$(kubectl auth can-i get pods --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get pods" \
  || fail "rpg-backend-sa can get pods (should not)"

# Verify the SA CANNOT access secrets
RESULT=$(kubectl auth can-i get secrets --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get secrets" \
  || fail "rpg-backend-sa can get secrets (should not)"

# Verify the SA CANNOT access jobs
RESULT=$(kubectl auth can-i get jobs --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get jobs" \
  || fail "rpg-backend-sa can get jobs (should not)"

# Verify the SA CANNOT create namespaces
RESULT=$(kubectl auth can-i create namespaces --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>/dev/null || true)
echo "$RESULT" | grep -q "no" \
  && pass "rpg-backend-sa CANNOT create namespaces" \
  || fail "rpg-backend-sa can create namespaces (should not)"

# --- Game logic leak checks ---

echo ""
echo "--- Game logic leak checks ---"

# Frontend should not have hardcoded HP/damage maps
FRONTEND_FILE="frontend/src/App.tsx"
GAME_LOGIC_LEAKS=0

# Check for hardcoded maxHP maps
if grep -q "warrior.*150.*mage.*80.*rogue.*100" "$FRONTEND_FILE" 2>/dev/null; then
  echo "  ❌ Frontend has hardcoded hero HP map"; GAME_LOGIC_LEAKS=1
else
  echo "  ✅ No hardcoded hero HP map in frontend"; pass "No hardcoded hero HP map"
fi

# Check for hardcoded difficulty HP maps
if grep -q "easy.*30.*normal.*50.*hard.*80" "$FRONTEND_FILE" 2>/dev/null; then
  echo "  ❌ Frontend has hardcoded monster HP map"; GAME_LOGIC_LEAKS=1
else
  echo "  ✅ No hardcoded monster HP map in frontend"; pass "No hardcoded monster HP map"
fi

# Check for hardcoded DICE config
if grep -q "^const DICE" "$FRONTEND_FILE" 2>/dev/null; then
  echo "  ❌ Frontend has hardcoded DICE config"; GAME_LOGIC_LEAKS=1
else
  echo "  ✅ No hardcoded DICE config in frontend"; pass "No hardcoded DICE config"
fi

[ "$GAME_LOGIC_LEAKS" -eq 0 ] || fail "Game logic leaked into frontend"

# Backend should not have combat logic (damage calc, counter-attacks, class modifiers)
BACKEND_FILE="backend/internal/handlers/handlers.go"
if grep -q "EFFECTIVE_DAMAGE\|counter.attack\|dodge.*chance\|damage.*reduction" "$BACKEND_FILE" 2>/dev/null; then
  echo "  ❌ Backend has combat logic"; fail "Combat logic in backend"
else
  echo "  ✅ No combat logic in backend"; pass "No combat logic in backend"
fi

# --- API response guardrails ---

echo ""
echo "--- API response checks ---"

# Start port-forward if not already running
PF_PID=""
GUARDRAIL_PORT=8083
if ! curl -s http://localhost:$GUARDRAIL_PORT/healthz &>/dev/null; then
  kubectl port-forward svc/rpg-backend -n rpg-system ${GUARDRAIL_PORT}:8080 &
  PF_PID=$!
  sleep 3
fi

# Create a test dungeon
TEST_NAME="guardrail-$(date +%s)"
curl -s -X POST http://localhost:$GUARDRAIL_PORT/api/v1/dungeons \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TEST_NAME\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null

sleep 10

# GetDungeon response must be a raw CR (not wrapped)
RESP=$(curl -s http://localhost:$GUARDRAIL_PORT/api/v1/dungeons/default/$TEST_NAME)
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert 'metadata' in d, 'missing metadata'
assert 'spec' in d, 'missing spec'
assert 'pods' not in d, 'response contains pods (must not)'
assert 'dungeon' not in d, 'response wrapped in dungeon key (must not)'
assert 'loot' not in d or isinstance(d.get('loot'), str), 'loot at top level'
" 2>/dev/null \
  && pass "GetDungeon returns raw CR (no pods, no wrapping)" \
  || fail "GetDungeon response has wrong shape"

# Cleanup
kubectl delete dungeon "$TEST_NAME"  --ignore-not-found --wait=false &>/dev/null
[ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null

# --- Summary ---

echo ""
echo "========================================"
echo "  Guardrail Tests: $PASS passed, $FAIL failed"
echo "========================================"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
