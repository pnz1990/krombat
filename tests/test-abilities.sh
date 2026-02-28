#!/usr/bin/env bash
# Group B: Hero abilities (heal, taunt, backstab) — 3 dungeons in parallel
source "$(dirname "$0")/helpers.sh"
TS=$(date +%s)
trap 'kubectl delete dungeons test-heal-$TS test-taunt-$TS test-backstab-$TS --ignore-not-found --wait=false 2>/dev/null; kubectl delete attacks -l test-group=abilities-$TS --ignore-not-found --wait=false 2>/dev/null' EXIT

# Create all 3 dungeons at once
log "Creating ability dungeons"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: test-heal-$TS
spec: {monsters: 1, difficulty: easy, monsterHP: [30], bossHP: 200, heroHP: 50, heroClass: mage, heroMana: 5, modifier: none}
---
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: test-taunt-$TS
spec: {monsters: 1, difficulty: easy, monsterHP: [30], bossHP: 200, heroHP: 150, heroClass: warrior, modifier: none}
---
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: test-backstab-$TS
spec: {monsters: 1, difficulty: easy, monsterHP: [30], bossHP: 200, heroHP: 100, heroClass: rogue, modifier: none}
EOF

# Wait for all 3 in parallel
wait_dungeon_ready "test-heal-$TS"
wait_dungeon_ready "test-taunt-$TS"
wait_dungeon_ready "test-backstab-$TS"

# Submit all 3 attacks at once
log "Submitting abilities"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: heal-$TS
  labels: {test-group: "abilities-$TS"}
spec: {dungeonName: "test-heal-$TS", dungeonNamespace: default, target: hero, damage: 0}
---
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: taunt-$TS
  labels: {test-group: "abilities-$TS"}
spec: {dungeonName: "test-taunt-$TS", dungeonNamespace: default, target: activate-taunt, damage: 0}
---
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: backstab-$TS
  labels: {test-group: "abilities-$TS"}
spec: {dungeonName: "test-backstab-$TS", dungeonNamespace: default, target: "test-backstab-$TS-monster-0-backstab", damage: 15}
EOF

# Wait for all 3 jobs
wait_job "heal-$TS"
wait_job "taunt-$TS"
wait_job "backstab-$TS"
sleep 3

# Verify heal
HP=$(kubectl get dungeon "test-heal-$TS" -o jsonpath='{.spec.heroHP}')
MANA=$(kubectl get dungeon "test-heal-$TS" -o jsonpath='{.spec.heroMana}')
[ "$HP" = "80" ] && pass "Mage heal: HP 50->80" || fail "Heal HP=$HP"
[ "$MANA" = "3" ] && pass "Mage heal: mana 5->3" || fail "Heal mana=$MANA"

# Verify taunt
wait_for "taunt" "[ \$(kubectl get dungeon test-taunt-$TS -o jsonpath='{.spec.tauntActive}' 2>/dev/null) = '1' ]" 15 \
  && pass "Warrior taunt: active=1" || fail "Taunt"

# Verify backstab
wait_for "backstab" "[ \$(kubectl get dungeon test-backstab-$TS -o jsonpath='{.spec.backstabCooldown}' 2>/dev/null) = '3' ]" 15
BS_HP=$(kubectl get dungeon "test-backstab-$TS" -o jsonpath='{.spec.monsterHP[0]}')
pass "Rogue backstab: cooldown=3"
[ "$BS_HP" = "0" ] && pass "Backstab: 3x kills monster" || fail "Backstab HP=$BS_HP"

summary "Abilities"
