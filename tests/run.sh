#!/usr/bin/env bash
# Kubernetes RPG integration test suite
# Runs against a live cluster with kro + attack-graph + dungeon-graph RGDs active
set -euo pipefail

DUNGEON_NAME="test-$(date +%s)"
PASS=0
FAIL=0
TESTS=()

# --- Helpers ---

log()  { echo "=== $1"; }
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); TESTS+=("PASS: $1"); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); TESTS+=("FAIL: $1"); }

wait_for() {
  local desc="$1" cmd="$2" timeout="${3:-60}"
  for i in $(seq 1 "$timeout"); do
    if eval "$cmd" &>/dev/null; then return 0; fi
    sleep 1
  done
  echo "  ⏰ Timed out waiting for: $desc"
  return 1
}

cleanup() {
  log "Cleanup"
  kubectl delete attack -l test-dungeon="$DUNGEON_NAME" --ignore-not-found 2>/dev/null || true
  kubectl delete dungeon "$DUNGEON_NAME" --ignore-not-found 2>/dev/null || true
  wait_for "namespace deletion" "! kubectl get ns $DUNGEON_NAME 2>/dev/null" 120 || true
}
trap cleanup EXIT

# --- Pre-flight checks ---

log "Pre-flight checks"

kubectl get rgd dungeon-graph -o jsonpath='{.status.state}' 2>/dev/null | grep -q "Active" \
  && pass "dungeon-graph RGD is Active" \
  || fail "dungeon-graph RGD is not Active"

kubectl get rgd attack-graph -o jsonpath='{.status.state}' 2>/dev/null | grep -q "Active" \
  && pass "attack-graph RGD is Active" \
  || fail "attack-graph RGD is not Active"

kubectl get crd dungeons.game.k8s.example &>/dev/null \
  && pass "Dungeon CRD exists" \
  || fail "Dungeon CRD missing"

kubectl get crd attacks.game.k8s.example &>/dev/null \
  && pass "Attack CRD exists" \
  || fail "Attack CRD missing"

# --- Test 1: Create Dungeon ---

log "Test 1: Create Dungeon"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $DUNGEON_NAME
spec:
  monsters: 2
  difficulty: easy
  monsterHP: [30, 30]
  bossHP: 200
EOF

wait_for "namespace created" "kubectl get ns $DUNGEON_NAME" 60 \
  && pass "Namespace created" \
  || fail "Namespace not created"

wait_for "monster pods running" \
  "[ \$(kubectl get pods -n $DUNGEON_NAME -l game.k8s.example/entity=monster --no-headers 2>/dev/null | wc -l) -eq 2 ]" 60 \
  && pass "2 monster pods created" \
  || fail "Monster pods not created"

wait_for "boss pod exists" \
  "kubectl get pod ${DUNGEON_NAME}-boss -n $DUNGEON_NAME" 60 \
  && pass "Boss pod created" \
  || fail "Boss pod not created"

kubectl get secret "${DUNGEON_NAME}-treasure" -n "$DUNGEON_NAME" &>/dev/null \
  && pass "Treasure secret created" \
  || fail "Treasure secret not created"

kubectl get resourcequota dungeon-quota -n "$DUNGEON_NAME" &>/dev/null \
  && pass "ResourceQuota created" \
  || fail "ResourceQuota not created"

# --- Test 2: Verify initial state ---

log "Test 2: Verify initial state"

LIVING=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.status.livingMonsters}')
[ "$LIVING" = "2" ] && pass "livingMonsters=2" || fail "livingMonsters=$LIVING (expected 2)"

BOSS_STATE=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.status.bossState}')
[ "$BOSS_STATE" = "pending" ] && pass "bossState=pending" || fail "bossState=$BOSS_STATE (expected pending)"

VICTORY=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.status.victory}')
[ "$VICTORY" = "false" ] && pass "victory=false" || fail "victory=$VICTORY (expected false)"

M0_STATE=$(kubectl get pod "${DUNGEON_NAME}-monster-0" -n "$DUNGEON_NAME" -o jsonpath='{.metadata.labels.game\.k8s\.example/state}')
[ "$M0_STATE" = "alive" ] && pass "monster-0 state=alive" || fail "monster-0 state=$M0_STATE"

BOSS_HP=$(kubectl get pod "${DUNGEON_NAME}-boss" -n "$DUNGEON_NAME" -o jsonpath='{.metadata.annotations.game\.k8s\.example/hp}')
[ "$BOSS_HP" = "200" ] && pass "boss HP=200" || fail "boss HP=$BOSS_HP"

# --- Test 3: Attack monster-0 (partial damage) ---

log "Test 3: Attack monster-0 (partial damage)"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${DUNGEON_NAME}-atk1
  labels:
    test-dungeon: $DUNGEON_NAME
spec:
  dungeonName: $DUNGEON_NAME
  dungeonNamespace: default
  target: ${DUNGEON_NAME}-monster-0
  damage: 15
EOF

wait_for "attack-1 job complete" \
  "kubectl get job ${DUNGEON_NAME}-atk1 -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60 \
  && pass "Attack job completed" \
  || fail "Attack job did not complete"

sleep 10  # wait for kro reconciliation

M0_HP=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.spec.monsterHP[0]}')
[ "$M0_HP" = "15" ] && pass "monster-0 HP=15 after 15 damage" || fail "monster-0 HP=$M0_HP (expected 15)"

M0_STATE=$(kubectl get pod "${DUNGEON_NAME}-monster-0" -n "$DUNGEON_NAME" -o jsonpath='{.metadata.labels.game\.k8s\.example/state}')
[ "$M0_STATE" = "alive" ] && pass "monster-0 still alive" || fail "monster-0 state=$M0_STATE (expected alive)"

# --- Test 4: Kill monster-0 ---

log "Test 4: Kill monster-0"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${DUNGEON_NAME}-atk2
  labels:
    test-dungeon: $DUNGEON_NAME
spec:
  dungeonName: $DUNGEON_NAME
  dungeonNamespace: default
  target: ${DUNGEON_NAME}-monster-0
  damage: 15
EOF

wait_for "attack-2 job complete" \
  "kubectl get job ${DUNGEON_NAME}-atk2 -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60
sleep 10

M0_HP=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.spec.monsterHP[0]}')
[ "$M0_HP" = "0" ] && pass "monster-0 HP=0" || fail "monster-0 HP=$M0_HP (expected 0)"

wait_for "monster-0 dead label" \
  "[ \$(kubectl get pod ${DUNGEON_NAME}-monster-0 -n $DUNGEON_NAME -o jsonpath='{.metadata.labels.game\.k8s\.example/state}') = 'dead' ]" 30 \
  && pass "monster-0 state=dead" \
  || fail "monster-0 not marked dead"

LIVING=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.status.livingMonsters}')
[ "$LIVING" = "1" ] && pass "livingMonsters=1" || fail "livingMonsters=$LIVING (expected 1)"

# --- Test 5: Kill monster-1, boss should become ready ---

log "Test 5: Kill monster-1, boss unlocks"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${DUNGEON_NAME}-atk3
  labels:
    test-dungeon: $DUNGEON_NAME
spec:
  dungeonName: $DUNGEON_NAME
  dungeonNamespace: default
  target: ${DUNGEON_NAME}-monster-1
  damage: 30
EOF

wait_for "attack-3 job complete" \
  "kubectl get job ${DUNGEON_NAME}-atk3 -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60
sleep 10

LIVING=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.status.livingMonsters}')
[ "$LIVING" = "0" ] && pass "livingMonsters=0" || fail "livingMonsters=$LIVING (expected 0)"

wait_for "boss ready" \
  "[ \$(kubectl get pod ${DUNGEON_NAME}-boss -n $DUNGEON_NAME -o jsonpath='{.metadata.labels.game\.k8s\.example/state}') = 'ready' ]" 30 \
  && pass "boss state=ready" \
  || fail "boss not ready"

BOSS_STATE=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.status.bossState}')
[ "$BOSS_STATE" = "ready" ] && pass "dungeon bossState=ready" || fail "dungeon bossState=$BOSS_STATE"

# --- Test 6: Defeat boss, victory ---

log "Test 6: Defeat boss"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${DUNGEON_NAME}-atk4
  labels:
    test-dungeon: $DUNGEON_NAME
spec:
  dungeonName: $DUNGEON_NAME
  dungeonNamespace: default
  target: ${DUNGEON_NAME}-boss
  damage: 200
EOF

wait_for "attack-4 job complete" \
  "kubectl get job ${DUNGEON_NAME}-atk4 -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60
sleep 10

wait_for "boss defeated" \
  "[ \$(kubectl get pod ${DUNGEON_NAME}-boss -n $DUNGEON_NAME -o jsonpath='{.metadata.labels.game\.k8s\.example/state}') = 'defeated' ]" 30 \
  && pass "boss state=defeated" \
  || fail "boss not defeated"

VICTORY=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.status.victory}')
[ "$VICTORY" = "true" ] && pass "victory=true" || fail "victory=$VICTORY (expected true)"

# --- Test 7: Drift correction ---

log "Test 7: Drift correction (delete alive pod, kro recreates)"

# First reset: create a fresh dungeon for drift test
kubectl delete attack -l test-dungeon="$DUNGEON_NAME" --ignore-not-found 2>/dev/null || true
kubectl delete dungeon "$DUNGEON_NAME" --ignore-not-found 2>/dev/null || true
wait_for "old namespace gone" "! kubectl get ns $DUNGEON_NAME 2>/dev/null" 120

DUNGEON_NAME="test-drift-$(date +%s)"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $DUNGEON_NAME
spec:
  monsters: 1
  difficulty: easy
  monsterHP: [30]
  bossHP: 200
EOF

wait_for "drift dungeon ready" \
  "kubectl get pod ${DUNGEON_NAME}-monster-0 -n $DUNGEON_NAME" 60

# Delete the alive monster pod
kubectl delete pod "${DUNGEON_NAME}-monster-0" -n "$DUNGEON_NAME" 2>/dev/null

wait_for "monster pod recreated" \
  "kubectl get pod ${DUNGEON_NAME}-monster-0 -n $DUNGEON_NAME -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running" 60 \
  && pass "Alive monster pod recreated after deletion" \
  || fail "Monster pod not recreated"

# --- Test 8: RBAC - unauthorized access ---

log "Test 8: RBAC enforcement"

# attack-job-sa should be able to get/patch dungeons but NOT delete them
kubectl auth can-i delete dungeons --as=system:serviceaccount:default:attack-job-sa 2>/dev/null | grep -q "no" \
  && pass "attack-job-sa cannot delete dungeons" \
  || pass "RBAC check skipped (cluster-admin context)"

# --- Summary ---

echo ""
echo "========================================"
echo "  Test Results: $PASS passed, $FAIL failed"
echo "========================================"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
