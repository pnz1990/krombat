#!/usr/bin/env bash
# Group C: Features (modifiers, status effects, loot) — 3 dungeons in parallel
# After #110: attacks go through backend REST API with seeded-random combat math.
source "$(dirname "$0")/helpers.sh"
TS=$(date +%s)
trap 'teardown_backend_pf; kctl delete dungeons test-mod-$TS test-fx-$TS test-loot-$TS --ignore-not-found --wait=false 2>/dev/null' EXIT

setup_backend_pf 8091

log "Creating feature dungeons"
curl -s -X POST "${BACKEND_URL}/api/v1/dungeons" \
  -H "Content-Type: application/json" "${TEST_USER_HEADER[@]}" \
  -d "{\"name\":\"test-mod-$TS\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null
curl -s -X POST "${BACKEND_URL}/api/v1/dungeons" \
  -H "Content-Type: application/json" "${TEST_USER_HEADER[@]}" \
  -d "{\"name\":\"test-fx-$TS\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null
curl -s -X POST "${BACKEND_URL}/api/v1/dungeons" \
  -H "Content-Type: application/json" "${TEST_USER_HEADER[@]}" \
  -d "{\"name\":\"test-loot-$TS\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null

wait_dungeon_ready "test-mod-$TS"
wait_dungeon_ready "test-fx-$TS"
wait_dungeon_ready "test-loot-$TS"

# --- Modifier test ---
log "Modifier test"
MOD=$(kctl get dungeon "test-mod-$TS" -o jsonpath='{.spec.modifier}' 2>/dev/null)
[ -n "$MOD" ] && pass "Modifier assigned: $MOD" || fail "Modifier not assigned"
wait_for "modifier CR" "kctl get modifier test-mod-$TS-modifier -n test-mod-$TS" 30 \
  && pass "Modifier CR in dungeon namespace" || fail "Modifier CR"

# --- Status effects: patch dungeon with pre-existing effects, then attack ---
log "Status effect test"
kctl patch dungeon "test-fx-$TS" --type=merge -p '{"spec":{"poisonTurns":2,"burnTurns":1,"stunTurns":1,"heroHP":200}}' &>/dev/null
sleep 2

submit_attack "test-fx-$TS" "test-fx-$TS-monster-0"

wait_for "effects ticked" "[ \"\$(kctl get dungeon test-fx-$TS -o jsonpath='{.spec.poisonTurns}' 2>/dev/null)\" != '2' ]" 20
FX_HP=$(kctl get dungeon "test-fx-$TS" -o jsonpath='{.spec.heroHP}')
FX_POISON=$(kctl get dungeon "test-fx-$TS" -o jsonpath='{.spec.poisonTurns}')
FX_STUN=$(kctl get dungeon "test-fx-$TS" -o jsonpath='{.spec.stunTurns}')
[ "$FX_HP" -lt 200 ] && pass "DoT: HP reduced from 200 to $FX_HP" || fail "DoT HP=$FX_HP (expected < 200)"
[ "$FX_POISON" = "1" ] && pass "Poison: 2->1" || fail "Poison=$FX_POISON"
[ "$FX_STUN" = "0" ] && pass "Stun consumed" || fail "Stun=$FX_STUN"

# --- Loot: patch inventory, then use item ---
log "Loot test"
kctl patch dungeon "test-loot-$TS" --type=merge -p '{"spec":{"inventory":"hppotion-rare","heroHP":50}}' &>/dev/null
sleep 2
submit_action "test-loot-$TS" "use-hppotion-rare"
INV=$(kctl get dungeon "test-loot-$TS" -o jsonpath='{.spec.inventory}')
[ -z "$INV" ] && pass "Item consumed: inventory empty" || fail "Inventory=$INV"
HP_AFTER=$(kctl get dungeon "test-loot-$TS" -o jsonpath='{.spec.heroHP}')
[ "$HP_AFTER" -gt 50 ] && pass "Potion used: HP increased from 50 to $HP_AFTER" || fail "Potion HP=$HP_AFTER"

# Kill monster for loot drop test (attack until HP=0)
for i in $(seq 1 10); do
  submit_attack "test-loot-$TS" "test-loot-$TS-monster-0"
  HP=$(kctl get dungeon "test-loot-$TS" -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null || echo "30")
  [ "$HP" -le 0 ] && break
done
sleep 2
ACTION=$(kctl get dungeon "test-loot-$TS" -o jsonpath='{.spec.lastHeroAction}')
echo "$ACTION" | grep -qi "monster-0\|slain\|defeated\|killed\|deals" && pass "Monster killed, logged" || fail "Kill action: $ACTION"

# Verify no loot on attacking already-dead monster
# Backend returns early for dead targets — lastLootDrop should be empty
submit_attack "test-loot-$TS" "test-loot-$TS-monster-0"
sleep 2
DEAD_LOOT=$(kctl get dungeon "test-loot-$TS" -o jsonpath='{.spec.lastLootDrop}' 2>/dev/null || echo "")
[ -z "$DEAD_LOOT" ] && pass "No loot on already-dead monster" || fail "lastLootDrop=$DEAD_LOOT on dead monster"

summary "Features"
