#!/usr/bin/env bash
# Group A: Core dungeon lifecycle (create, attack, kill, boss, victory)
source "$(dirname "$0")/helpers.sh"
D="test-core-$(date +%s)"
trap 'kubectl delete dungeon "$D" --ignore-not-found --wait=false 2>/dev/null; kubectl delete attacks -l test-dungeon="$D" --ignore-not-found --wait=false 2>/dev/null' EXIT

log "Create dungeon"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $D
spec:
  monsters: 2
  difficulty: easy
  monsterHP: [30, 30]
  bossHP: 200
  heroHP: 150
  heroClass: warrior
  modifier: none
EOF

wait_for "namespace" "kubectl get ns $D" 60 && pass "Namespace created" || fail "Namespace"
wait_for "monsters" "[ \$(kubectl get monsters -n $D --no-headers 2>/dev/null | wc -l) -eq 2 ]" 60 && pass "2 monster CRs" || fail "Monsters"
wait_for "boss" "kubectl get boss ${D}-boss -n $D" 60 && pass "Boss CR" || fail "Boss"
wait_for "hero" "kubectl get hero ${D}-hero -n $D" 60 && pass "Hero CR" || fail "Hero"
wait_for "treasure" "kubectl get treasure ${D}-treasure -n $D" 60 && pass "Treasure CR" || fail "Treasure"

wait_for "livingMonsters=2" "[ \$(kubectl get dungeon $D -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '2' ]" 30 && pass "livingMonsters=2" || fail "livingMonsters"
wait_for "bossState=pending" "[ \$(kubectl get dungeon $D -o jsonpath='{.status.bossState}' 2>/dev/null) = 'pending' ]" 30 && pass "bossState=pending" || fail "bossState"

log "Attack monster-0 (partial)"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${D}-atk1
  labels: {test-dungeon: "$D"}
spec: {dungeonName: "$D", dungeonNamespace: default, target: "${D}-monster-0", damage: 15}
EOF
wait_job "${D}-atk1"
wait_for "HP=15" "[ \$(kubectl get dungeon $D -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null) = '15' ]" 30 && pass "monster-0 HP=15" || fail "HP"

log "Kill monster-0"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${D}-atk2
  labels: {test-dungeon: "$D"}
spec: {dungeonName: "$D", dungeonNamespace: default, target: "${D}-monster-0", damage: 15}
EOF
wait_job "${D}-atk2"
wait_for "HP=0" "[ \$(kubectl get dungeon $D -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null) = '0' ]" 30 && pass "monster-0 HP=0" || fail "HP"
wait_for "living=1" "[ \$(kubectl get dungeon $D -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '1' ]" 30 && pass "livingMonsters=1" || fail "living"

log "Kill monster-1, boss unlocks"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${D}-atk3
  labels: {test-dungeon: "$D"}
spec: {dungeonName: "$D", dungeonNamespace: default, target: "${D}-monster-1", damage: 30}
EOF
wait_job "${D}-atk3"
wait_for "living=0" "[ \$(kubectl get dungeon $D -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '0' ]" 30 && pass "livingMonsters=0" || fail "living"
wait_for "boss ready" "[ \$(kubectl get dungeon $D -o jsonpath='{.status.bossState}' 2>/dev/null) = 'ready' ]" 30 && pass "bossState=ready" || fail "boss"

log "Defeat boss"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: ${D}-atk4
  labels: {test-dungeon: "$D"}
spec: {dungeonName: "$D", dungeonNamespace: default, target: "${D}-boss", damage: 200}
EOF
wait_job "${D}-atk4"
wait_for "victory" "[ \$(kubectl get dungeon $D -o jsonpath='{.status.victory}' 2>/dev/null) = 'true' ]" 30 && pass "victory=true" || fail "victory"

summary "Core Lifecycle"
