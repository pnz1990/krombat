#!/usr/bin/env bash
# Group B: Hero abilities (heal, taunt, backstab) — 3 dungeons in parallel
# After #110: attacks go through backend REST API with seeded-random combat math.
source "$(dirname "$0")/helpers.sh"
TS=$(date +%s)
trap 'teardown_backend_pf; kctl delete dungeons test-heal-$TS test-taunt-$TS test-backstab-$TS --ignore-not-found --wait=false 2>/dev/null' EXIT

setup_backend_pf 8090

log "Creating ability dungeons"
curl -s -X POST "${BACKEND_URL}/api/v1/dungeons" \
  -H "Content-Type: application/json" "${TEST_USER_HEADER[@]}" \
  -d "{\"name\":\"test-heal-$TS\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"mage\"}" -o /dev/null
curl -s -X POST "${BACKEND_URL}/api/v1/dungeons" \
  -H "Content-Type: application/json" "${TEST_USER_HEADER[@]}" \
  -d "{\"name\":\"test-taunt-$TS\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null
curl -s -X POST "${BACKEND_URL}/api/v1/dungeons" \
  -H "Content-Type: application/json" "${TEST_USER_HEADER[@]}" \
  -d "{\"name\":\"test-backstab-$TS\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"rogue\"}" -o /dev/null

wait_dungeon_ready "test-heal-$TS"
wait_dungeon_ready "test-taunt-$TS"
wait_dungeon_ready "test-backstab-$TS"

# For heal test: reduce hero HP below 80% of 120 = 96 so heal is enabled
# Game state now lives in status.game — patch via status subresource
kctl patch dungeon "test-heal-$TS" --subresource=status --type=merge -p '{"status":{"game":{"heroHP":50,"heroMana":8}}}' &>/dev/null
sleep 2

log "Submitting abilities"
# Heal (mage: target=hero)
submit_attack "test-heal-$TS" "hero"
HP=$(kctl get dungeon "test-heal-$TS" -o jsonpath='{.status.game.heroHP}')
MANA=$(kctl get dungeon "test-heal-$TS" -o jsonpath='{.status.game.heroMana}')
[ "$HP" -gt 50 ] && pass "Mage heal: HP increased from 50 (now $HP)" || fail "Heal HP=$HP (expected > 50)"
[ "$MANA" -lt 8 ] && pass "Mage heal: mana consumed (8→$MANA)" || fail "Heal mana=$MANA (expected < 8)"

# Taunt (warrior: target=activate-taunt)
submit_attack "test-taunt-$TS" "activate-taunt"
wait_for "taunt" "[ \$(kctl get dungeon test-taunt-$TS -o jsonpath='{.status.game.tauntActive}' 2>/dev/null) = '1' ]" 15 \
  && pass "Warrior taunt: active=1" || fail "Taunt"

# Backstab (rogue: target includes -backstab suffix)
submit_attack "test-backstab-$TS" "test-backstab-$TS-monster-0-backstab"
wait_for "backstab cooldown" "[ \"\$(kctl get dungeon test-backstab-$TS -o jsonpath='{.status.game.backstabCooldown}' 2>/dev/null)\" = '3' ]" 15 \
  && pass "Rogue backstab: cooldown=3" || fail "Backstab cooldown"
BS_HP=$(kctl get dungeon "test-backstab-$TS" -o jsonpath='{.status.game.monsterHP[0]}')
[ "$BS_HP" -lt 30 ] && pass "Backstab: monster HP reduced to $BS_HP" || fail "Backstab HP=$BS_HP (expected < 30)"

summary "Abilities"
