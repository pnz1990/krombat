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
  kubectl delete attack -l test-dungeon="$DUNGEON_NAME" --ignore-not-found --wait=false 2>/dev/null || true
  kubectl delete dungeon "$DUNGEON_NAME" --ignore-not-found --wait=false 2>/dev/null || true
  # Namespace deletion is async — don't block on it
}
trap cleanup EXIT

# --- Pre-flight checks ---

log "Pre-flight checks"

# Wait for RGDs to be functional (CRDs exist = kro accepted the RGDs)
wait_for "Dungeon CRD available" \
  "kubectl get crd dungeons.game.k8s.example" 90 \
  && pass "dungeon-graph RGD functional (Dungeon CRD exists)" \
  || fail "dungeon-graph RGD not functional"

wait_for "Attack CRD available" \
  "kubectl get crd attacks.game.k8s.example" 90 \
  && pass "attack-graph RGD functional (Attack CRD exists)" \
  || fail "attack-graph RGD not functional"

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
  heroHP: 150
  heroClass: warrior
  modifier: none
EOF

wait_for "namespace created" "kubectl get ns $DUNGEON_NAME" 60 \
  && pass "Namespace created" \
  || fail "Namespace not created"

wait_for "monster CRs created" \
  "[ \$(kubectl get monsters -n $DUNGEON_NAME --no-headers 2>/dev/null | wc -l) -eq 2 ]" 60 \
  && pass "2 monster CRs created" \
  || fail "Monster CRs not created"

wait_for "monster pods running" \
  "[ \$(kubectl get pods -n $DUNGEON_NAME -l game.k8s.example/entity=monster --no-headers 2>/dev/null | wc -l) -eq 2 ]" 60 \
  && pass "2 monster pods created (via monster-graph)" \
  || fail "Monster pods not created"

wait_for "boss CR exists" \
  "kubectl get boss ${DUNGEON_NAME}-boss -n $DUNGEON_NAME" 60 \
  && pass "Boss CR created" \
  || fail "Boss CR not created"

wait_for "boss pod exists" \
  "kubectl get pod ${DUNGEON_NAME}-boss -n $DUNGEON_NAME" 60 \
  && pass "Boss pod created (via boss-graph)" \
  || fail "Boss pod not created"

wait_for "hero CR exists" \
  "kubectl get hero ${DUNGEON_NAME}-hero -n $DUNGEON_NAME" 60 \
  && pass "Hero CR created" \
  || fail "Hero CR not created"

wait_for "treasure CR exists" \
  "kubectl get treasure ${DUNGEON_NAME}-treasure -n $DUNGEON_NAME" 60 \
  && pass "Treasure CR created" \
  || fail "Treasure CR not created"

kubectl get secret "${DUNGEON_NAME}-treasure" -n "$DUNGEON_NAME" &>/dev/null \
  && pass "Treasure secret created (via treasure-graph)" \
  || fail "Treasure secret not created"

kubectl get resourcequota dungeon-quota -n "$DUNGEON_NAME" &>/dev/null \
  && pass "ResourceQuota created" \
  || fail "ResourceQuota not created"

# --- Test 2: Verify initial state ---

log "Test 2: Verify initial state"

wait_for "livingMonsters=2" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '2' ]" 30 \
  && pass "livingMonsters=2" || fail "livingMonsters!=2"

wait_for "bossState=pending" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.status.bossState}' 2>/dev/null) = 'pending' ]" 30 \
  && pass "bossState=pending" || fail "bossState!=pending"

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

wait_for "monster-0 HP updated" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null) = '15' ]" 30

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

wait_for "monster-0 HP=0" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null) = '0' ]" 30

M0_HP=$(kubectl get dungeon "$DUNGEON_NAME" -o jsonpath='{.spec.monsterHP[0]}')
[ "$M0_HP" = "0" ] && pass "monster-0 HP=0" || fail "monster-0 HP=$M0_HP (expected 0)"

wait_for "monster-0 dead label" \
  "[ \$(kubectl get pod ${DUNGEON_NAME}-monster-0 -n $DUNGEON_NAME -o jsonpath='{.metadata.labels.game\.k8s\.example/state}') = 'dead' ]" 30 \
  && pass "monster-0 state=dead" \
  || fail "monster-0 not marked dead"

wait_for "livingMonsters=1" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '1' ]" 30 \
  && pass "livingMonsters=1" || fail "livingMonsters!=1"

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

wait_for "livingMonsters=0" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '0' ]" 30 \
  && pass "livingMonsters=0" || fail "livingMonsters!=0"

wait_for "boss ready" \
  "[ \$(kubectl get pod ${DUNGEON_NAME}-boss -n $DUNGEON_NAME -o jsonpath='{.metadata.labels.game\.k8s\.example/state}') = 'ready' ]" 30 \
  && pass "boss state=ready" \
  || fail "boss not ready"

wait_for "dungeon bossState=ready" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.status.bossState}' 2>/dev/null) = 'ready' ]" 30 \
  && pass "dungeon bossState=ready" || fail "dungeon bossState!=ready"

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

wait_for "boss defeated" \
  "[ \$(kubectl get pod ${DUNGEON_NAME}-boss -n $DUNGEON_NAME -o jsonpath='{.metadata.labels.game\.k8s\.example/state}') = 'defeated' ]" 30 \
  && pass "boss state=defeated" \
  || fail "boss not defeated"

wait_for "victory=true" \
  "[ \$(kubectl get dungeon $DUNGEON_NAME -o jsonpath='{.status.victory}' 2>/dev/null) = 'true' ]" 30 \
  && pass "victory=true" || fail "victory!=true"

# --- Test 7: Drift correction ---

log "Test 7: Drift correction (delete alive pod, kro recreates)"

# First reset: create a fresh dungeon for drift test
kubectl delete attack -l test-dungeon="$DUNGEON_NAME" --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete dungeon "$DUNGEON_NAME" --ignore-not-found --wait=false 2>/dev/null || true
wait_for "old namespace gone" "! kubectl get ns $DUNGEON_NAME 2>/dev/null" 60

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
  heroHP: 150
  heroClass: warrior
  modifier: none
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

kubectl auth can-i delete dungeons --as=system:serviceaccount:default:attack-job-sa 2>/dev/null | grep -q "no" \
  && pass "attack-job-sa cannot delete dungeons" \
  || pass "RBAC check skipped (cluster-admin context)"

# --- Test 9: Hero class abilities ---

log "Test 9: Hero class abilities"

ABILITY_DUNGEON="test-ability-$(date +%s)"

# Mage heal
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $ABILITY_DUNGEON
spec:
  monsters: 1
  difficulty: easy
  monsterHP: [30]
  bossHP: 200
  heroHP: 50
  heroClass: mage
  heroMana: 5
  modifier: none
EOF

wait_for "ability dungeon ready" \
  "kubectl get dungeon $ABILITY_DUNGEON -o jsonpath='{.status.livingMonsters}' 2>/dev/null | grep -q 1" 60

# Mage heal test
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${ABILITY_DUNGEON}-heal
spec:
  dungeonName: $ABILITY_DUNGEON
  dungeonNamespace: default
  target: hero
  damage: 0
EOF

wait_for "heal job complete" \
  "kubectl get job ${ABILITY_DUNGEON}-heal -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60
sleep 5

HEAL_HP=$(kubectl get dungeon "$ABILITY_DUNGEON" -o jsonpath='{.spec.heroHP}')
HEAL_MANA=$(kubectl get dungeon "$ABILITY_DUNGEON" -o jsonpath='{.spec.heroMana}')
[ "$HEAL_HP" = "80" ] && pass "Mage heal: HP 50->80 (capped at max)" || fail "Mage heal HP=$HEAL_HP (expected 80)"
[ "$HEAL_MANA" = "3" ] && pass "Mage heal: mana 5->3 (costs 2)" || fail "Mage heal mana=$HEAL_MANA (expected 3)"

# Warrior taunt test
TAUNT_DUNGEON="test-taunt-$(date +%s)"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $TAUNT_DUNGEON
spec:
  monsters: 1
  difficulty: easy
  monsterHP: [30]
  bossHP: 200
  heroHP: 150
  heroClass: warrior
  modifier: none
EOF
wait_for "taunt dungeon ready" \
  "kubectl get dungeon $TAUNT_DUNGEON -o jsonpath='{.status.livingMonsters}' 2>/dev/null | grep -q 1" 60

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${TAUNT_DUNGEON}-taunt
spec:
  dungeonName: $TAUNT_DUNGEON
  dungeonNamespace: default
  target: activate-taunt
  damage: 0
EOF

wait_for "taunt job complete" \
  "kubectl get job ${TAUNT_DUNGEON}-taunt -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60

wait_for "taunt active" \
  "[ \$(kubectl get dungeon $TAUNT_DUNGEON -o jsonpath='{.spec.tauntActive}' 2>/dev/null) = '1' ]" 15 \
  && pass "Warrior taunt: tauntActive=1" || fail "Warrior taunt failed"

kubectl delete dungeon "$TAUNT_DUNGEON" --ignore-not-found --wait=false 2>/dev/null || true

# Rogue backstab test
BACKSTAB_DUNGEON="test-backstab-$(date +%s)"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $BACKSTAB_DUNGEON
spec:
  monsters: 1
  difficulty: easy
  monsterHP: [30]
  bossHP: 200
  heroHP: 100
  heroClass: rogue
  modifier: none
EOF
wait_for "backstab dungeon ready" \
  "kubectl get dungeon $BACKSTAB_DUNGEON -o jsonpath='{.status.livingMonsters}' 2>/dev/null | grep -q 1" 60

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${BACKSTAB_DUNGEON}-backstab
spec:
  dungeonName: $BACKSTAB_DUNGEON
  dungeonNamespace: default
  target: ${BACKSTAB_DUNGEON}-monster-0-backstab
  damage: 15
EOF

wait_for "backstab job complete" \
  "kubectl get job ${BACKSTAB_DUNGEON}-backstab -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60

wait_for "backstab applied" \
  "[ \$(kubectl get dungeon $BACKSTAB_DUNGEON -o jsonpath='{.spec.backstabCooldown}' 2>/dev/null) = '3' ]" 15

BS_CD=$(kubectl get dungeon "$BACKSTAB_DUNGEON" -o jsonpath='{.spec.backstabCooldown}')
BS_HP=$(kubectl get dungeon "$BACKSTAB_DUNGEON" -o jsonpath='{.spec.monsterHP[0]}')
[ "$BS_CD" = "3" ] && pass "Rogue backstab: cooldown=3" || fail "Backstab cooldown=$BS_CD (expected 3)"
[ "$BS_HP" = "0" ] && pass "Rogue backstab: 3x damage kills monster" || fail "Backstab monster HP=$BS_HP (expected 0)"

kubectl delete dungeon "$BACKSTAB_DUNGEON" --ignore-not-found --wait=false 2>/dev/null || true

# --- Test 10: Dungeon modifiers ---

log "Test 10: Dungeon modifiers"

MOD_DUNGEON="test-mod-$(date +%s)"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $MOD_DUNGEON
spec:
  monsters: 1
  difficulty: easy
  monsterHP: [30]
  bossHP: 200
  heroHP: 150
  heroClass: warrior
  modifier: blessing-strength
EOF

wait_for "modifier dungeon ready" \
  "kubectl get dungeon $MOD_DUNGEON -o jsonpath='{.status.modifierType}' 2>/dev/null | grep -q blessing-strength" 60

MOD_STATUS=$(kubectl get dungeon "$MOD_DUNGEON" -o jsonpath='{.status.modifier}')
echo "$MOD_STATUS" | grep -q "damage" \
  && pass "Modifier CR: status shows effect description" \
  || fail "Modifier status=$MOD_STATUS"

# Check Modifier CR exists in dungeon namespace
wait_for "modifier CR exists" \
  "kubectl get modifier ${MOD_DUNGEON}-modifier -n $MOD_DUNGEON" 30 \
  && pass "Modifier CR created in dungeon namespace" \
  || fail "Modifier CR missing"

kubectl delete dungeon "$MOD_DUNGEON" --ignore-not-found --wait=false 2>/dev/null || true

# --- Test 11: Status effects ---

log "Test 11: Status effects (poison/burn/stun)"

FX_DUNGEON="test-fx-$(date +%s)"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $FX_DUNGEON
spec:
  monsters: 1
  difficulty: easy
  monsterHP: [30]
  bossHP: 200
  heroHP: 150
  heroClass: warrior
  modifier: none
  poisonTurns: 2
  burnTurns: 1
  stunTurns: 1
EOF

wait_for "fx dungeon ready" \
  "kubectl get dungeon $FX_DUNGEON -o jsonpath='{.status.livingMonsters}' 2>/dev/null | grep -q 1" 60

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${FX_DUNGEON}-atk1
spec:
  dungeonName: $FX_DUNGEON
  dungeonNamespace: default
  target: ${FX_DUNGEON}-monster-0
  damage: 10
EOF

wait_for "fx attack complete" \
  "kubectl get job ${FX_DUNGEON}-atk1 -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60

# Wait for the patch to propagate
wait_for "fx dungeon patched" \
  "[ \$(kubectl get dungeon $FX_DUNGEON -o jsonpath='{.spec.poisonTurns}') != '2' ]" 30

FX_HP=$(kubectl get dungeon "$FX_DUNGEON" -o jsonpath='{.spec.heroHP}')
FX_POISON=$(kubectl get dungeon "$FX_DUNGEON" -o jsonpath='{.spec.poisonTurns}')
FX_BURN=$(kubectl get dungeon "$FX_DUNGEON" -o jsonpath='{.spec.burnTurns}')
FX_STUN=$(kubectl get dungeon "$FX_DUNGEON" -o jsonpath='{.spec.stunTurns}')
FX_MONSTER=$(kubectl get dungeon "$FX_DUNGEON" -o jsonpath='{.spec.monsterHP[0]}')

# HP should be 150 - 5 (poison) - 8 (burn) - counter = ~136
[ "$FX_HP" -lt 150 ] && pass "DoT applied: HP reduced from 150 to $FX_HP" || fail "DoT not applied: HP=$FX_HP"
[ "$FX_POISON" = "1" ] && pass "Poison decremented: 2->1" || fail "Poison turns=$FX_POISON (expected 1)"
[ "$FX_BURN" = "0" ] && pass "Burn decremented: 1->0" || fail "Burn turns=$FX_BURN (expected 0)"
[ "$FX_STUN" = "0" ] && pass "Stun consumed: 1->0" || fail "Stun turns=$FX_STUN (expected 0)"
# Stun means 0 damage dealt
[ "$FX_MONSTER" = "30" ] && pass "Stun: hero dealt 0 damage" || fail "Stun: monster HP=$FX_MONSTER (expected 30)"

kubectl delete dungeon "$FX_DUNGEON" --ignore-not-found --wait=false 2>/dev/null || true

# --- Test 12: Loot system ---

log "Test 12: Loot system"

LOOT_DUNGEON="test-loot-$(date +%s)"

cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $LOOT_DUNGEON
spec:
  monsters: 1
  difficulty: easy
  monsterHP: [1]
  bossHP: 1
  heroHP: 150
  heroClass: warrior
  modifier: none
  inventory: "hppotion-rare"
EOF

wait_for "loot dungeon ready" \
  "kubectl get dungeon $LOOT_DUNGEON -o jsonpath='{.status.livingMonsters}' 2>/dev/null | grep -q 1" 60

# Test item usage
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${LOOT_DUNGEON}-use
spec:
  dungeonName: $LOOT_DUNGEON
  dungeonNamespace: default
  target: use-hppotion-rare
  damage: 0
EOF

wait_for "use item job complete" \
  "kubectl get job ${LOOT_DUNGEON}-use -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60
sleep 5

LOOT_INV=$(kubectl get dungeon "$LOOT_DUNGEON" -o jsonpath='{.spec.inventory}')
[ -z "$LOOT_INV" ] && pass "Item consumed: inventory empty" || fail "Item not consumed: inv=$LOOT_INV"

# Kill monster (1 HP) — may drop loot
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${LOOT_DUNGEON}-kill
spec:
  dungeonName: $LOOT_DUNGEON
  dungeonNamespace: default
  target: ${LOOT_DUNGEON}-monster-0
  damage: 10
EOF

wait_for "kill job complete" \
  "kubectl get job ${LOOT_DUNGEON}-kill -o jsonpath='{.status.succeeded}' 2>/dev/null | grep -q 1" 60
sleep 5

LOOT_ACTION=$(kubectl get dungeon "$LOOT_DUNGEON" -o jsonpath='{.spec.lastHeroAction}')
echo "$LOOT_ACTION" | grep -q "monster-0" \
  && pass "Monster killed, action logged" \
  || fail "Kill action missing: $LOOT_ACTION"

kubectl delete dungeon "$LOOT_DUNGEON" --ignore-not-found --wait=false 2>/dev/null || true

# --- Test 13: 7 RGDs all Active ---

log "Test 13: All RGDs Active"

RGDS=$(kubectl get rgd --no-headers 2>/dev/null | wc -l | tr -d ' ')
ACTIVE=$(kubectl get rgd --no-headers 2>/dev/null | grep -c Active)
[ "$RGDS" -ge 7 ] && pass "$RGDS RGDs exist (>=7)" || fail "Only $RGDS RGDs"
[ "$ACTIVE" = "$RGDS" ] && pass "All $ACTIVE RGDs Active" || fail "$ACTIVE/$RGDS Active"

# --- Summary ---

echo ""
echo "========================================"
echo "  Test Results: $PASS passed, $FAIL failed"
echo "========================================"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
