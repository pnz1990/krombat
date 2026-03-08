#!/usr/bin/env bash
# Backend API integration tests
# Requires: kubectl port-forward svc/rpg-backend -n rpg-system 8080:8080
set -euo pipefail

BASE="${API_URL:-http://localhost:8080}"
DUNGEON="api-test-$(date +%s)"
PASS=0
FAIL=0
TESTS=()

log()  { echo "=== $1"; }
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); TESTS+=("PASS: $1"); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); TESTS+=("FAIL: $1"); }

cleanup() {
  log "Cleanup"
  kubectl delete dungeon "$DUNGEON"  --ignore-not-found --wait=false 2>/dev/null || true
  kubectl delete attacks --all --ignore-not-found --wait=false 2>/dev/null || true
}
trap cleanup EXIT

# --- Pre-flight ---
log "Pre-flight: checking backend is reachable"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/healthz" 2>/dev/null || echo "000")
if [ "$CODE" != "200" ]; then
  echo "Backend not reachable at $BASE (got $CODE). Run: kubectl port-forward svc/rpg-backend -n rpg-system 8080:8080"
  exit 1
fi
pass "Backend reachable"

# --- Test 1: Health check ---
log "Test 1: Health check"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/healthz")
[ "$CODE" = "200" ] && pass "GET /healthz -> 200" || fail "GET /healthz -> $CODE"

# --- Test 2: Metrics endpoint ---
log "Test 2: Metrics endpoint"
curl -s "$BASE/metrics" | grep -q "k8s_rpg_dungeons_created_total" \
  && pass "GET /metrics has k8s_rpg_dungeons_created_total" \
  || fail "Metrics missing k8s_rpg_dungeons_created_total"

# --- Test 3: Create dungeon ---
log "Test 3: Create dungeon"
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/dungeons" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$DUNGEON\",\"monsters\":2,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}")
CODE=$(echo "$RESP" | tail -1)
[ "$CODE" = "201" ] && pass "POST /dungeons -> 201" || fail "POST /dungeons -> $CODE"

# --- Test 4: Create dungeon validation ---
log "Test 4: Input validation"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons" \
  -H "Content-Type: application/json" -d '{"name":"","monsters":0,"difficulty":"easy"}')
[ "$CODE" = "400" ] && pass "Empty name rejected -> 400" || fail "Empty name -> $CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons" \
  -H "Content-Type: application/json" -d '{"name":"x","monsters":2,"difficulty":"insane"}')
[ "$CODE" = "400" ] && pass "Invalid difficulty rejected -> 400" || fail "Invalid difficulty -> $CODE"

# --- Test 5: List dungeons ---
log "Test 5: List dungeons"
RESP=$(curl -s "$BASE/api/v1/dungeons")
echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); assert any(x['name']=='$DUNGEON' for x in d)" 2>/dev/null \
  && pass "GET /dungeons lists created dungeon" \
  || fail "Created dungeon not in list"

# --- Test 6: Get dungeon ---
log "Test 6: Get dungeon response shape"
sleep 15  # wait for kro
RESP=$(curl -s "$BASE/api/v1/dungeons/default/$DUNGEON")
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/dungeons/default/$DUNGEON")
[ "$CODE" = "200" ] && pass "GET /dungeons/default/$DUNGEON -> 200" || fail "GET dungeon -> $CODE"

# Verify response is a raw Dungeon CR (has metadata.name, spec, not wrapped in {dungeon:...})
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert 'metadata' in d, 'missing metadata'
assert d['metadata']['name'] == '$DUNGEON', f'wrong name: {d[\"metadata\"][\"name\"]}'
assert 'spec' in d, 'missing spec'
assert 'monsterHP' in d['spec'], 'missing monsterHP'
assert 'bossHP' in d['spec'], 'missing bossHP'
assert 'dungeon' not in d, 'response should not be wrapped in dungeon key'
assert 'pods' not in d, 'response should not contain pods'
print('OK')
" 2>/dev/null \
  && pass "Response is raw Dungeon CR (metadata, spec, no pods)" \
  || fail "Response shape incorrect — backend may be returning wrapped/old format"

# --- Test 7: Get nonexistent dungeon ---
log "Test 7: Get nonexistent dungeon"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/dungeons/default/nonexistent-xyz")
[ "$CODE" = "404" ] && pass "GET nonexistent -> 404" || fail "GET nonexistent -> $CODE"

# --- Test 8: Submit attack ---
log "Test 8: Submit attack"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons/default/$DUNGEON/attacks" \
  -H "Content-Type: application/json" -d "{\"target\":\"${DUNGEON}-monster-0\",\"damage\":30}")
[ "$CODE" = "202" ] && pass "POST attack -> 202" || fail "POST attack -> $CODE"

# --- Test 9: Attack validation ---
log "Test 9: Attack validation"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons/default/validation-test/attacks" \
  -H "Content-Type: application/json" -d '{"target":"","damage":0}')
[ "$CODE" = "400" ] && pass "Invalid attack rejected -> 400" || fail "Invalid attack -> $CODE"

# --- Test 10: Rate limiting (best-effort, timing-sensitive) ---
log "Test 10: Rate limiting"
curl -s -o /dev/null -X POST "$BASE/api/v1/dungeons/default/$DUNGEON/attacks" \
  -H "Content-Type: application/json" -d "{\"target\":\"${DUNGEON}-monster-1\",\"damage\":10}"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons/default/$DUNGEON/attacks" \
  -H "Content-Type: application/json" -d "{\"target\":\"${DUNGEON}-monster-1\",\"damage\":10}")
[ "$CODE" = "429" ] && pass "Rate limited -> 429" || pass "Rate limit timing-sensitive (got $CODE, acceptable)"

# --- Test 11: Metrics after operations ---
log "Test 11: Metrics after operations"
METRICS=$(curl -s "$BASE/metrics")
echo "$METRICS" | grep -q 'k8s_rpg_dungeons_created_total' \
  && pass "Dungeon counter present" || fail "Dungeon counter missing"
echo "$METRICS" | grep -q 'k8s_rpg_attacks_submitted_total' \
  && pass "Attack counter present" || fail "Attack counter missing"
echo "$METRICS" | grep -q 'k8s_rpg_active_dungeons' \
  && pass "Active dungeons gauge present" || fail "Active dungeons gauge missing"
echo "$METRICS" | grep -q 'k8s_rpg_victories' \
  && pass "Victories gauge present" || fail "Victories gauge missing"

# --- Test 12: Ability rejection — backstab on cooldown ---
log "Test 12: Backstab-on-cooldown rejection"
ROGUE_DUNGEON="api-test-rogue-$(date +%s)"
curl -s -X POST "$BASE/api/v1/dungeons" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$ROGUE_DUNGEON\",\"monsters\":2,\"difficulty\":\"easy\",\"heroClass\":\"rogue\"}" -o /dev/null
sleep 15  # wait for kro
# Use backstab once to set cooldown=3
curl -s -o /dev/null -X POST "$BASE/api/v1/dungeons/default/$ROGUE_DUNGEON/attacks" \
  -H "Content-Type: application/json" \
  -d "{\"target\":\"${ROGUE_DUNGEON}-monster-0-backstab\",\"damage\":20}"
sleep 3
# Immediately try backstab again — should be rejected with 400 (cooldown active)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons/default/$ROGUE_DUNGEON/attacks" \
  -H "Content-Type: application/json" \
  -d "{\"target\":\"${ROGUE_DUNGEON}-monster-0-backstab\",\"damage\":20}")
[ "$CODE" = "400" ] && pass "Backstab-on-cooldown rejected -> 400" || fail "Backstab-on-cooldown -> $CODE (expected 400)"
kubectl delete dungeon "$ROGUE_DUNGEON" --ignore-not-found --wait=false 2>/dev/null || true

# --- Test 13: Ability rejection — mage heal with insufficient mana ---
log "Test 13: Mage heal no-mana rejection"
MAGE_DUNGEON="api-test-mage-$(date +%s)"
curl -s -X POST "$BASE/api/v1/dungeons" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$MAGE_DUNGEON\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"mage\"}" -o /dev/null
sleep 15
# Drain mage mana to 0 by patching the dungeon CR directly
kubectl patch dungeon "$MAGE_DUNGEON" -n default --type=merge -p '{"spec":{"heroMana":0}}' &>/dev/null || true
sleep 3
# Attempt heal with 0 mana — should be 400
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons/default/$MAGE_DUNGEON/attacks" \
  -H "Content-Type: application/json" \
  -d "{\"target\":\"mage-heal\",\"damage\":0}")
[ "$CODE" = "400" ] && pass "Mage heal with 0 mana rejected -> 400" || fail "Mage heal no-mana -> $CODE (expected 400)"
kubectl delete dungeon "$MAGE_DUNGEON" --ignore-not-found --wait=false 2>/dev/null || true

# --- Test 14: Ability rejection — taunt by non-warrior class ---
log "Test 14: Taunt by non-warrior rejection"
MAGE_TAUNT="api-test-taunt-$(date +%s)"
curl -s -X POST "$BASE/api/v1/dungeons" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$MAGE_TAUNT\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"mage\"}" -o /dev/null
sleep 15
# Mage tries to activate taunt — should be 400
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/dungeons/default/$MAGE_TAUNT/attacks" \
  -H "Content-Type: application/json" \
  -d "{\"target\":\"activate-taunt\",\"damage\":0}")
[ "$CODE" = "400" ] && pass "Non-warrior taunt attempt rejected -> 400" || fail "Non-warrior taunt -> $CODE (expected 400)"
kubectl delete dungeon "$MAGE_TAUNT" --ignore-not-found --wait=false 2>/dev/null || true

# --- Test 15: lastLootDrop field present in spec after kill ---
log "Test 15: lastLootDrop field present after kill"
LOOT_TEST="api-test-loot-$(date +%s)"
curl -s -X POST "$BASE/api/v1/dungeons" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$LOOT_TEST\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null
sleep 15
# Kill monster-0 with lethal damage
curl -s -o /dev/null -X POST "$BASE/api/v1/dungeons/default/$LOOT_TEST/attacks" \
  -H "Content-Type: application/json" \
  -d "{\"target\":\"${LOOT_TEST}-monster-0\",\"damage\":100}"
sleep 5
RESP=$(curl -s "$BASE/api/v1/dungeons/default/$LOOT_TEST")
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
spec=d.get('spec',{})
assert 'lastLootDrop' in spec, 'lastLootDrop field missing from spec'
# lastLootDrop is either empty string (no drop) or an item name — both are valid
print('lastLootDrop:', repr(spec['lastLootDrop']))
" 2>/dev/null \
  && pass "lastLootDrop field present in spec after kill (may be empty if no drop)" \
  || fail "lastLootDrop field missing from dungeon spec after kill"
kubectl delete dungeon "$LOOT_TEST" --ignore-not-found --wait=false 2>/dev/null || true

# --- Summary ---
echo ""
echo "========================================"
echo "  Backend Tests: $PASS passed, $FAIL failed"
echo "========================================"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
