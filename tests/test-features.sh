#!/usr/bin/env bash
# Group C: Features (modifiers, status effects, loot) — 3 dungeons in parallel
source "$(dirname "$0")/helpers.sh"
TS=$(date +%s)
trap 'kubectl delete dungeons test-mod-$TS test-fx-$TS test-loot-$TS --ignore-not-found --wait=false 2>/dev/null; kubectl delete attacks -l test-group=features-$TS --ignore-not-found --wait=false 2>/dev/null' EXIT

log "Creating feature dungeons"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: test-mod-$TS
spec: {monsters: 1, difficulty: easy, monsterHP: [30], bossHP: 200, heroHP: 150, heroClass: warrior, modifier: blessing-strength}
---
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: test-fx-$TS
spec: {monsters: 1, difficulty: easy, monsterHP: [30], bossHP: 200, heroHP: 150, heroClass: warrior, modifier: none, poisonTurns: 2, burnTurns: 1, stunTurns: 1}
---
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: test-loot-$TS
spec: {monsters: 1, difficulty: easy, monsterHP: [1], bossHP: 1, heroHP: 150, heroClass: warrior, modifier: none, inventory: "hppotion-rare"}
EOF

wait_dungeon_ready "test-mod-$TS"
wait_dungeon_ready "test-fx-$TS"
wait_dungeon_ready "test-loot-$TS"

# --- Modifier test ---
log "Modifier test"
wait_for "modifier status" "kubectl get dungeon test-mod-$TS -o jsonpath='{.status.modifierType}' 2>/dev/null | grep -q blessing-strength" 30 \
  && pass "Modifier: blessing-strength in status" || fail "Modifier status"
wait_for "modifier CR" "kubectl get modifier test-mod-$TS-modifier -n test-mod-$TS" 30 \
  && pass "Modifier CR in dungeon namespace" || fail "Modifier CR"

# --- Status effects + loot: submit attacks in parallel ---
log "Submitting feature attacks"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: fx-atk-$TS
  labels: {test-group: "features-$TS"}
spec: {dungeonName: "test-fx-$TS", dungeonNamespace: default, target: "test-fx-$TS-monster-0", damage: 10}
---
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: loot-use-$TS
  labels: {test-group: "features-$TS"}
spec: {dungeonName: "test-loot-$TS", dungeonNamespace: default, target: "use-hppotion-rare", damage: 0}
EOF

wait_job "fx-atk-$TS"
wait_job "loot-use-$TS"

# --- Verify effects ---
log "Verify status effects"
wait_for "poison patched" "[ \$(kubectl get dungeon test-fx-$TS -o jsonpath='{.spec.poisonTurns}') != '2' ]" 20
FX_HP=$(kubectl get dungeon "test-fx-$TS" -o jsonpath='{.spec.heroHP}')
FX_POISON=$(kubectl get dungeon "test-fx-$TS" -o jsonpath='{.spec.poisonTurns}')
FX_STUN=$(kubectl get dungeon "test-fx-$TS" -o jsonpath='{.spec.stunTurns}')
FX_MONSTER=$(kubectl get dungeon "test-fx-$TS" -o jsonpath='{.spec.monsterHP[0]}')
[ "$FX_HP" -lt 150 ] && pass "DoT: HP reduced to $FX_HP" || fail "DoT HP=$FX_HP"
[ "$FX_POISON" = "1" ] && pass "Poison: 2->1" || fail "Poison=$FX_POISON"
[ "$FX_STUN" = "0" ] && pass "Stun consumed" || fail "Stun=$FX_STUN"
[ "$FX_MONSTER" = "30" ] && pass "Stun: 0 damage dealt" || fail "Monster=$FX_MONSTER"

# --- Verify loot ---
log "Verify loot"
sleep 3
INV=$(kubectl get dungeon "test-loot-$TS" -o jsonpath='{.spec.inventory}')
[ -z "$INV" ] && pass "Item consumed: inventory empty" || fail "Inventory=$INV"

# Kill monster for loot drop test
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: loot-kill-$TS
  labels: {test-group: "features-$TS"}
spec: {dungeonName: "test-loot-$TS", dungeonNamespace: default, target: "test-loot-$TS-monster-0", damage: 10}
EOF
wait_job "loot-kill-$TS"
sleep 3
ACTION=$(kubectl get dungeon "test-loot-$TS" -o jsonpath='{.spec.lastHeroAction}')
echo "$ACTION" | grep -q "monster-0" && pass "Monster killed, logged" || fail "Kill action: $ACTION"

summary "Features"
