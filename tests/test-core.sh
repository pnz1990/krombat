#!/usr/bin/env bash
# Group A: Core dungeon lifecycle (create, attack, kill, boss, victory)
# After #110: attacks go through backend REST API with seeded-random combat math.
# We poll state changes via kubectl — no wait_job needed.
source "$(dirname "$0")/helpers.sh"
D="test-core-$(date +%s)"
trap 'teardown_backend_pf; kctl delete dungeon "$D" --ignore-not-found --wait=false 2>/dev/null; kctl delete attacks --field-selector metadata.name="${D}-latest-attack" --ignore-not-found --wait=false 2>/dev/null' EXIT

setup_backend_pf 8089

log "Create dungeon"
curl -s -X POST "${BACKEND_URL}/api/v1/dungeons" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${D}\",\"monsters\":2,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null

wait_for "namespace" "kctl get ns $D" 60 && pass "Namespace created" || fail "Namespace"
wait_for "monsters" "[ \$(kctl get monsters -n $D --no-headers 2>/dev/null | wc -l) -eq 2 ]" 60 && pass "2 monster CRs" || fail "Monsters"
wait_for "boss" "kctl get boss ${D}-boss -n $D" 60 && pass "Boss CR" || fail "Boss"
wait_for "hero" "kctl get hero ${D}-hero -n $D" 60 && pass "Hero CR" || fail "Hero"
wait_for "treasure" "kctl get treasure ${D}-treasure -n $D" 60 && pass "Treasure CR" || fail "Treasure"

wait_for "livingMonsters=2" "[ \$(kctl get dungeon $D -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '2' ]" 30 && pass "livingMonsters=2" || fail "livingMonsters"
wait_for "bossState=pending" "[ \$(kctl get dungeon $D -o jsonpath='{.status.bossState}' 2>/dev/null) = 'pending' ]" 30 && pass "bossState=pending" || fail "bossState"

log "Attack monster-0 until dead"
for i in $(seq 1 10); do
  submit_attack "$D" "${D}-monster-0"
  HP=$(kctl get dungeon "$D" -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null || echo "30")
  [ "$HP" -le 0 ] && break
done
HP=$(kctl get dungeon "$D" -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null)
[ "$HP" -le 0 ] && pass "monster-0 HP=0" || fail "monster-0 HP=$HP after 10 attacks"

wait_for "living=1" "[ \$(kctl get dungeon $D -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '1' ]" 60 && pass "livingMonsters=1" || fail "livingMonsters"

log "Kill monster-1, boss unlocks"
for i in $(seq 1 10); do
  submit_attack "$D" "${D}-monster-1"
  HP=$(kctl get dungeon "$D" -o jsonpath='{.spec.monsterHP[1]}' 2>/dev/null || echo "30")
  [ "$HP" -le 0 ] && break
done
wait_for "living=0" "[ \$(kctl get dungeon $D -o jsonpath='{.status.livingMonsters}' 2>/dev/null) = '0' ]" 30 && pass "livingMonsters=0" || fail "livingMonsters"
wait_for "boss ready" "[ \$(kctl get dungeon $D -o jsonpath='{.status.bossState}' 2>/dev/null) = 'ready' ]" 60 && pass "bossState=ready" || fail "boss"

log "Defeat boss"
for i in $(seq 1 50); do
  submit_attack "$D" "${D}-boss"
  BOSS_HP=$(kctl get dungeon "$D" -o jsonpath='{.spec.bossHP}' 2>/dev/null || echo "200")
  [ "$BOSS_HP" -le 0 ] && break
done
wait_for "victory" "[ \$(kctl get dungeon $D -o jsonpath='{.status.victory}' 2>/dev/null) = 'true' ]" 60 && pass "victory=true" || fail "victory"

summary "Core Lifecycle"
