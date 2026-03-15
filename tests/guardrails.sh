#!/usr/bin/env bash
# Guardrail: Ensure backend ONLY interacts with kro-generated CRs
# This test prevents regression — the backend must never touch native K8s objects
set -euo pipefail

KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-arn:aws:eks:us-west-2:319279230668:cluster/krombat}"
kctl() { kubectl --context "$KUBECTL_CONTEXT" "$@"; }

# Auth bypass header — backend accepts X-Test-User when KROMBAT_TEST_USER env matches.
# Value is read from the krombat-test-auth K8s Secret (never committed to git).
_TEST_USER="$(kubectl --context "$KUBECTL_CONTEXT" get secret krombat-test-auth \
  -n rpg-system -o jsonpath='{.data.KROMBAT_TEST_USER}' 2>/dev/null | base64 -d 2>/dev/null || echo "")"
if [ -z "$_TEST_USER" ]; then
  echo "⚠️  krombat-test-auth secret not found — live API guardrail checks will skip auth" >&2
fi
AUTH_H=(-H "X-Test-User: ${_TEST_USER}")

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
# The check looks for GroupVersionResource literals where Group is not game.k8s.example.
# Whitelisted exceptions (both intentional and covered by dedicated RBAC):
#   leaderboardGVR — core group configmap for leaderboard, protected by rpg-backend-leaderboard Role
#   coreGrp/coreVer GVRs — read-only K8s log viewer in the kro teaching layer
# Lines using the 'grp' variable are game.k8s.example GVRs (grp := "game.k8s.example").
NON_GAME_GVR=$(grep -rn "GroupVersionResource{" "$BACKEND_DIR/internal/" 2>/dev/null \
  | grep -v "game.k8s.example" \
  | grep -v 'Group: grp\|Group: coreGrp\|leaderboardGVR' \
  || true)
[ -z "$NON_GAME_GVR" ] \
  && pass "All GVR definitions are game.k8s.example (leaderboard and kro-inspector CMs whitelisted)" \
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

# Leaderboard Role must exist and be scoped to configmaps only
LEADERBOARD_ROLE=$(grep -A 10 'name: rpg-backend-leaderboard' "$RBAC_FILE" | head -10 || true)
echo "$LEADERBOARD_ROLE" | grep -q 'configmaps' \
  && pass "rpg-backend-leaderboard Role scoped to configmaps" \
  || fail "rpg-backend-leaderboard Role missing or not scoped to configmaps"

# Leaderboard Role must only allow krombat-leaderboard (resourceNames guard)
echo "$LEADERBOARD_ROLE" | grep -q 'krombat-leaderboard' \
  && pass "rpg-backend-leaderboard Role restricted to krombat-leaderboard by resourceNames" \
  || fail "rpg-backend-leaderboard Role missing resourceNames guard — too broad"

# Leaderboard Role must NOT grant secrets access
echo "$LEADERBOARD_ROLE" | grep -q 'secrets' \
  && fail "rpg-backend-leaderboard Role grants secrets access (should not)" \
  || pass "rpg-backend-leaderboard Role does not grant secrets access"

# --- Live cluster guardrails ---

echo ""
echo "--- Live cluster checks ---"

# Verify the SA can access dungeons
RESULT=$(kctl auth can-i get dungeons.game.k8s.example --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "yes" ] \
  && pass "rpg-backend-sa can get dungeons" \
  || fail "rpg-backend-sa cannot get dungeons"

# Verify the SA CANNOT access pods
RESULT=$(kctl auth can-i get pods --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get pods" \
  || fail "rpg-backend-sa can get pods (should not)"

# Verify the SA CANNOT access secrets
RESULT=$(kctl auth can-i get secrets --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get secrets" \
  || fail "rpg-backend-sa can get secrets (should not)"

# Verify the SA CANNOT access jobs
RESULT=$(kctl auth can-i get jobs --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get jobs" \
  || fail "rpg-backend-sa can get jobs (should not)"

# Verify the SA CANNOT create namespaces
RESULT=$(kctl auth can-i create namespaces --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>/dev/null || true)
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

# Backend combat logic is INTENTIONAL after #110 refactor — all combat math lives in Go.
# Guard: RGDs must NOT contain combat logic (ensures no regression back to Job-based model)
ATTACK_RGD="manifests/rgds/attack-graph.yaml"
if grep -q "EFFECTIVE_DAMAGE\|seededRoll\|HERO_DAMAGE" "$ATTACK_RGD" 2>/dev/null; then
  echo "  ❌ attack-graph RGD has combat logic (must be a no-op stub)"; fail "Combat logic in attack-graph RGD"
else
  echo "  ✅ attack-graph RGD is a no-op stub (combat logic lives in Go)"; pass "No combat logic in attack-graph RGD"
fi

# --- API response guardrails ---

echo ""
echo "--- API response checks ---"

# Start port-forward if not already running
PF_PID=""
GUARDRAIL_PORT=8083
if ! curl -s http://localhost:$GUARDRAIL_PORT/healthz &>/dev/null; then
  kctl port-forward svc/rpg-backend -n rpg-system ${GUARDRAIL_PORT}:8080 &
  PF_PID=$!
  sleep 3
fi

# Create a test dungeon
TEST_NAME="guardrail-$(date +%s)"
curl -s -X POST http://localhost:$GUARDRAIL_PORT/api/v1/dungeons \
  "${AUTH_H[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TEST_NAME\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null

sleep 10

# GetDungeon response must be a raw CR (not wrapped)
RESP=$(curl -s "${AUTH_H[@]}" http://localhost:$GUARDRAIL_PORT/api/v1/dungeons/default/$TEST_NAME)
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
kctl delete dungeon "$TEST_NAME"  --ignore-not-found --wait=false &>/dev/null
[ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null

# --- Loot guardrails ---
echo "=== Loot guardrails"
# After #110: loot logic lives in Go (handlers.go), not in attack-graph.yaml (which is a no-op stub).
# Guard: loot drop is gated on kill transition (OLD_HP>0 && NEW_HP==0) in handlers.go
LOOT_KILL_GUARD=$(grep -c 'oldHP > 0 && newHP == 0\|prevHP > 0 && newHP <= 0\|killTransition\|isKill' backend/internal/handlers/handlers.go 2>/dev/null || echo 0)
[ "$LOOT_KILL_GUARD" -ge 1 ] && pass "Loot gated on kill transition in Go handler ($LOOT_KILL_GUARD checks)" || fail "Missing kill-transition guard in Go handler"

# Guard: item actions clear lastLootDrop
ITEM_CLEAR=$(grep -c 'lastLootDrop.*""' backend/internal/handlers/handlers.go 2>/dev/null || echo 0)
[ "$ITEM_CLEAR" -ge 1 ] && pass "Go handler clears lastLootDrop on non-kill actions" || fail "Go handler missing lastLootDrop clear"

grep -q 'return.*Items done' frontend/src/App.tsx && pass "Item actions early-return (no loot fallthrough)" || fail "Item actions missing early return"

# Guard: monster-graph RGD gates Loot CR on hp==0 (includeWhen)
# This ensures the kro engine never creates a Loot CR for a living monster.
MONSTER_LOOT_GUARD=$(grep -c 'schema.spec.hp == 0' manifests/rgds/monster-graph.yaml 2>/dev/null || echo 0)
[ "$MONSTER_LOOT_GUARD" -ge 1 ] && pass "monster-graph RGD gates Loot CR on hp==0 (includeWhen)" || fail "monster-graph missing includeWhen hp==0 guard"

# Guard: boss-graph RGD gates Loot CR on hp==0 (includeWhen)
BOSS_LOOT_GUARD=$(grep -c 'schema.spec.hp == 0\|bossHP.*== 0\|hp.*==.*0' manifests/rgds/boss-graph.yaml 2>/dev/null || echo 0)
[ "$BOSS_LOOT_GUARD" -ge 1 ] && pass "boss-graph RGD gates Loot CR/resources on hp==0" || fail "boss-graph missing hp==0 guard"

# Guard: loot state is computed by kro combatResolve (not Go backend math)
# Verify the dungeon-graph combatResolve still has loot logic
LOOT_CEL=$(grep -c 'lastLootDrop\|loot' manifests/rgds/dungeon-graph.yaml 2>/dev/null || echo 0)
[ "$LOOT_CEL" -ge 1 ] && pass "kro combatResolve manages loot state (lastLootDrop in dungeon-graph)" || fail "dungeon-graph missing loot/lastLootDrop — kro not computing loot"

# Live cluster guard: Loot Secret must NOT exist while monster is alive, MUST exist after kill
echo "=== Loot Secret live guard"
LOOT_TEST="loot-guard-$(date +%s)"
PF_LOOT_PID=""
LOOT_PORT=8085
if ! curl -s http://localhost:$LOOT_PORT/healthz &>/dev/null; then
  kctl port-forward svc/rpg-backend -n rpg-system ${LOOT_PORT}:8080 &
  PF_LOOT_PID=$!
  sleep 3
fi

# Create a 1-monster easy dungeon so we can kill it in one shot (easy=30 HP, warrior hits ~12-22)
curl -s -X POST http://localhost:$LOOT_PORT/api/v1/dungeons \
  "${AUTH_H[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$LOOT_TEST\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null
sleep 10  # wait for kro to reconcile

# Verify no Loot Secret exists while monster-0 is alive (hp > 0)
# The dungeon namespace matches the dungeon name (created by dungeon-graph)
LOOT_SECRET_BEFORE=$(kctl get secret "${LOOT_TEST}-monster-0-loot" -n "$LOOT_TEST" --ignore-not-found 2>/dev/null || true)
[ -z "$LOOT_SECRET_BEFORE" ] && pass "No Loot Secret while monster is alive (hp > 0)" || fail "Loot Secret exists before monster killed"

# Kill monster-0 — send attacks until monster HP reaches 0.
# seq:-1 disables the stale-request guard so retries work cleanly.
# Easy warrior damage is ~12-22/attack on 30 HP, so at most 3 attacks needed.
KILL_ATTEMPTS=0
while [ $KILL_ATTEMPTS -lt 5 ]; do
  curl -s -X POST http://localhost:$LOOT_PORT/api/v1/dungeons/default/$LOOT_TEST/attacks \
    "${AUTH_H[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"target\":\"${LOOT_TEST}-monster-0\",\"damage\":100,\"seq\":-1}" -o /dev/null
  sleep 5
  MONSTER_HP=$(kctl get dungeon "$LOOT_TEST" -n default -o jsonpath='{.spec.monsterHP[0]}' 2>/dev/null || echo "99")
  [ "$MONSTER_HP" = "0" ] && break
  KILL_ATTEMPTS=$((KILL_ATTEMPTS+1))
done
sleep 15  # wait for full kro chain: monster-graph → Loot CR → loot-graph → Secret

# Verify Loot Secret exists now that monster-0 is dead (hp == 0)
# kro creates the Secret in the dungeon namespace (same as the Loot CR and Monster CR)
LOOT_SECRET_AFTER=$(kctl get secret "${LOOT_TEST}-monster-0-loot" -n "$LOOT_TEST" --ignore-not-found 2>/dev/null || true)
[ -n "$LOOT_SECRET_AFTER" ] && pass "Loot Secret exists after monster killed (hp == 0)" || fail "Loot Secret missing after monster killed"

# Verify lastLootDrop field is present in dungeon spec (may be empty if no drop — that is valid)
LOOT_DROP_FIELD=$(kctl get dungeon "$LOOT_TEST" -n default -o jsonpath='{.spec.lastLootDrop}' 2>/dev/null || echo "__missing__")
[ "$LOOT_DROP_FIELD" != "__missing__" ] && pass "lastLootDrop field present in dungeon spec after kill" || fail "lastLootDrop field missing from dungeon spec"

# Cleanup loot test dungeon (deleting the dungeon CR cascades to the namespace via ownerReferences)
kctl delete dungeon "$LOOT_TEST" -n default --ignore-not-found --wait=false &>/dev/null
[ -n "$PF_LOOT_PID" ] && kill "$PF_LOOT_PID" 2>/dev/null

# --- loot-graph includeWhen drop guard (direct Monster CR) ---
# Guard: loot-graph Secret must NOT be created for a living monster (hp > 0),
# and MUST be created once hp is patched to 0. Tests the kro includeWhen gate directly,
# bypassing the backend API, to verify the RGD-level invariant.
echo "=== loot-graph includeWhen drop guard (direct Monster CR)"
DROP_GUARD_NAME="loot-drop-guard-$(date +%s)"
DROP_GUARD_NS="default"

# Apply a Monster CR with hp=10 (alive) directly — no dungeon needed for this RGD test
kctl apply -f - &>/dev/null <<EOF
apiVersion: game.k8s.example/v1alpha1
kind: Monster
metadata:
  name: ${DROP_GUARD_NAME}
  namespace: ${DROP_GUARD_NS}
spec:
  dungeonName: ${DROP_GUARD_NAME}
  index: 0
  hp: 10
  difficulty: easy
EOF

sleep 8  # wait for kro to reconcile

# Assert: no Loot CR while monster is alive (hp > 0)
LOOT_CR_ALIVE=$(kctl get loot "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -z "$LOOT_CR_ALIVE" ] \
  && pass "loot-graph: no Loot CR created for living monster (hp > 0)" \
  || fail "loot-graph: Loot CR created for living monster (hp > 0) — includeWhen guard broken"

# Assert: no loot Secret while monster is alive
LOOT_SEC_ALIVE=$(kctl get secret "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -z "$LOOT_SEC_ALIVE" ] \
  && pass "loot-graph: no loot Secret created for living monster (hp > 0)" \
  || fail "loot-graph: loot Secret created for living monster (hp > 0) — includeWhen guard broken"

# Patch hp to 0 (kill transition) directly on the Monster CR
kctl patch monster "${DROP_GUARD_NAME}" -n "$DROP_GUARD_NS" \
  --type=merge -p '{"spec":{"hp":0}}' &>/dev/null

sleep 8  # wait for kro to reconcile loot-graph

# Assert: Loot CR now exists (hp == 0 satisfies includeWhen)
LOOT_CR_DEAD=$(kctl get loot "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -n "$LOOT_CR_DEAD" ] \
  && pass "loot-graph: Loot CR created after monster killed (hp == 0)" \
  || fail "loot-graph: Loot CR missing after monster killed (hp == 0) — includeWhen not firing"

# Assert: loot Secret now exists (loot-graph reconciled from the Loot CR)
LOOT_SEC_DEAD=$(kctl get secret "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -n "$LOOT_SEC_DEAD" ] \
  && pass "loot-graph: loot Secret created after monster killed (hp == 0)" \
  || fail "loot-graph: loot Secret missing after monster killed (hp == 0) — loot-graph not reconciling"

# Cleanup
kctl delete monster "${DROP_GUARD_NAME}" -n "$DROP_GUARD_NS" --ignore-not-found --wait=false &>/dev/null
kctl delete loot "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found --wait=false &>/dev/null

# --- Combat/Action separation guardrails ---
echo "=== Combat/Action separation"
# After #110: attack-graph and action-graph are no-op stubs (resources: []).
# Guard: Go handler routes item actions separately from combat actions.
ITEM_ROUTING=$(grep -c 'isItem\|open-treasure\|unlock-door\|enter-room-2\|equip-\|use-' backend/internal/handlers/handlers.go 2>/dev/null || echo 0)
[ "$ITEM_ROUTING" -ge 3 ] && pass "Go handler routes item/equip/door actions separately ($ITEM_ROUTING refs)" || fail "Go handler missing item action routing"
# RGDs must remain no-op stubs
ATTACK_RGD_RESOURCES=$(grep 'resources:' manifests/rgds/attack-graph.yaml 2>/dev/null | grep -v '^\s*#' | head -1)
echo "$ATTACK_RGD_RESOURCES" | grep -q '\[\]' && pass "attack-graph RGD is a no-op stub (resources: [])" || fail "attack-graph RGD has resources (expected no-op)"
ACTION_RGD_RESOURCES=$(grep 'resources:' manifests/rgds/action-graph.yaml 2>/dev/null | grep -v '^\s*#' | head -1)
echo "$ACTION_RGD_RESOURCES" | grep -q '\[\]' && pass "action-graph RGD is a no-op stub (resources: [])" || fail "action-graph RGD has resources (expected no-op)"

# --- Combat animation guardrails ---
echo "=== Combat animation guardrails"
grep -q "inCombat && attackTarget === mName) mAction = 'attack'" frontend/src/App.tsx && pass "Monster target uses attack anim during combat" || fail "Monster target not using attack anim"
grep -q "inCombat && state === 'alive') mAction = 'attack'" frontend/src/App.tsx && pass "Alive monsters use attack anim during combat" || fail "Alive monsters not using attack anim"
grep -q "inCombatB && attackTarget.*boss.*bAction = 'attack'" frontend/src/App.tsx && pass "Boss target uses attack anim during combat" || fail "Boss target not using attack anim"
CLEAR_COUNT=$(grep -c "setAttackTarget(null)" frontend/src/App.tsx)
[ "$CLEAR_COUNT" -le 4 ] && pass "attackTarget cleared only in dismiss/catch/item ($CLEAR_COUNT)" || fail "attackTarget cleared too many places: $CLEAR_COUNT"
grep -q "opacity.*dead.*0.35" frontend/src/Sprite.tsx && pass "Dead sprites have reduced opacity" || fail "Dead sprites missing opacity"

# --- kro teaching layer guardrails ---
echo "=== kro teaching layer guardrails"
grep -q "InsightCard" frontend/src/App.tsx && pass "InsightCard wired into App" || fail "InsightCard missing from App"
grep -q "KroGraphPanel" frontend/src/App.tsx && pass "KroGraphPanel wired into App" || fail "KroGraphPanel missing from App"
grep -q "KroGlossary" frontend/src/App.tsx && pass "KroGlossary wired into EventLogTabs" || fail "KroGlossary missing from App"
grep -q "kroAnnotate" frontend/src/App.tsx && pass "K8s log annotations wired in" || fail "K8s log annotations missing"
grep -q "triggerInsight.*dungeon-created" frontend/src/App.tsx && pass "Dungeon creation triggers insight" || fail "Dungeon creation insight missing"
grep -q "triggerInsight.*monster-killed" frontend/src/App.tsx && pass "Monster kill triggers insight" || fail "Monster kill insight missing"
grep -q "KRO_STATUS_TIPS" frontend/src/App.tsx && pass "Status bar kro tooltips wired in" || fail "Status bar kro tooltips missing"
[ -f "frontend/src/KroTeach.tsx" ] && pass "KroTeach.tsx exists" || fail "KroTeach.tsx missing"
[ -f "frontend/src/KroGraph.tsx" ] && pass "KroGraph.tsx exists" || fail "KroGraph.tsx missing"

# --- Multi-phase boss guardrails ---
echo "=== Multi-phase boss guardrails"
grep -zq "phase1\|phase2\|phase3" manifests/rgds/boss-graph.yaml && pass "boss-graph derives phase from HP thresholds" || fail "boss-graph missing phase derivation"
grep -q "damageMultiplier" manifests/rgds/boss-graph.yaml && pass "boss-graph exposes damageMultiplier in status" || fail "boss-graph missing damageMultiplier"
grep -q "bossPhase" manifests/rgds/dungeon-graph.yaml && pass "dungeon-graph exposes bossPhase in status" || fail "dungeon-graph missing bossPhase status field"
grep -q "bossDamageMultiplier" manifests/rgds/dungeon-graph.yaml && pass "dungeon-graph exposes bossDamageMultiplier in status" || fail "dungeon-graph missing bossDamageMultiplier status field"
grep -q "bossDamageMultiplier\|bossDmgMultiplier" backend/internal/handlers/handlers.go && fail "Backend reading bossDamageMultiplier — kro is authoritative for counter-attack scaling, Go should not re-read it" || pass "Backend delegates boss counter-attack scaling to kro (no bossDamageMultiplier read)"
grep -q "boss-phase2\|boss-phase3" frontend/src/App.tsx && pass "Frontend applies boss phase CSS classes" || fail "Frontend missing boss phase CSS classes"
grep -q "boss-phase-badge" frontend/src/App.tsx && pass "Frontend renders boss phase badge" || fail "Frontend missing boss phase badge"
grep -q "ENRAGED\|BERSERK" frontend/src/App.tsx && pass "Frontend emits phase transition events to combat log" || fail "Frontend missing phase transition log events"

# --- KroGraph concept reference sanity ---
echo "=== KroGraph concept reference guardrails"
 ! grep -q "concept: 'secrets'" frontend/src/KroGraph.tsx && pass "KroGraph has no dangling 'secrets' concept reference" || fail "KroGraph references unknown concept 'secrets' — use 'secret-output'"

echo "=== KroTeach concept count sync"
node -e "
const fs = require('fs');
const src = fs.readFileSync('frontend/src/KroTeach.tsx', 'utf8');

// Count union type entries: lines matching \"  | 'xxx'\" between KroConceptId = and the next blank line after
const unionMatches = src.match(/export type KroConceptId =[\s\S]*?(?=\n\nexport)/);
const unionCount = unionMatches ? (unionMatches[0].match(/\| '/g) || []).length : 0;

// Count KRO_CONCEPTS keys: object properties of the form  'xxx': {
const conceptsMatches = (src.match(/^  '[a-zA-Z][a-zA-Z0-9-]*': \{$/gm) || []).length;

// Count CONCEPT_ORDER entries: strings inside the array
const orderMatch = src.match(/const CONCEPT_ORDER: KroConceptId\[\] = \[([\s\S]*?)\]/);
const orderCount = orderMatch ? (orderMatch[1].match(/'[a-zA-Z][a-zA-Z0-9-]*'/g) || []).length : 0;

console.log('Union type entries: ' + unionCount);
console.log('KRO_CONCEPTS entries: ' + conceptsMatches);
console.log('CONCEPT_ORDER entries: ' + orderCount);

if (unionCount !== conceptsMatches || conceptsMatches !== orderCount) {
  console.error('FAIL: concept counts out of sync — union=' + unionCount + ' concepts=' + conceptsMatches + ' order=' + orderCount);
  process.exit(1);
}
console.log('OK: all concept counts match (' + unionCount + ')');
" && pass "KroTeach concept counts in sync (union == KRO_CONCEPTS == CONCEPT_ORDER)" || fail "KroTeach concept counts out of sync — add/remove concept in all 3 places"

# --- Enemy variety guardrails ---
echo "=== Enemy variety guardrails"
grep -q "monsterTypes" backend/internal/handlers/handlers.go && pass "Backend assigns monsterTypes to dungeon spec" || fail "Backend missing monsterTypes assignment"
grep -q "archer\|shaman" manifests/rgds/dungeon-graph.yaml && pass "kro dungeon-graph assigns archer/shaman monster types (CEL)" || fail "dungeon-graph missing archer/shaman type assignment"
grep -q "getMonsterName" frontend/src/Sprite.tsx && pass "Sprite.tsx exports getMonsterName function" || fail "getMonsterName missing from Sprite.tsx"
grep -q "getMonsterName" frontend/src/App.tsx && pass "App.tsx uses getMonsterName for display labels" || fail "App.tsx not using getMonsterName"
grep -q "Archer.*STUNNED\|STUNNED.*Archer\|archer.*stun\|stun.*archer" backend/internal/handlers/handlers.go && pass "Backend implements Archer stun mechanic" || fail "Archer stun mechanic missing from backend"
grep -q "Shaman.*heal\|shaman.*heal" backend/internal/handlers/handlers.go && pass "Backend implements Shaman heal mechanic" || fail "Shaman heal mechanic missing from backend"

# --- New Game+ guardrails ---
echo "=== New Game+ guardrails"
grep -q "runCount" backend/internal/handlers/handlers.go && pass "Backend handles runCount in CreateDungeon" || fail "Backend missing runCount handling"
grep -q "runCount.*20\|20.*runCount" backend/internal/handlers/handlers.go && pass "Backend clamps runCount to max 20 (overflow guard)" || fail "Backend missing runCount overflow guard"
grep -q "1\.25\|125\|scale.*125\|125.*scale" manifests/rgds/dungeon-graph.yaml && pass "kro dungeon-graph applies 1.25x HP scaling per NG+ run (CEL)" || fail "dungeon-graph missing 1.25x NG+ HP scaling"
grep -q "createNewGamePlus" frontend/src/api.ts && pass "Frontend api.ts exports createNewGamePlus" || fail "createNewGamePlus missing from api.ts"
grep -q "onNewGamePlus\|handleNewGamePlus" frontend/src/App.tsx && pass "App.tsx wires New Game+ handler" || fail "App.tsx missing New Game+ handler"
grep -q "ng-plus-badge" frontend/src/App.tsx && pass "App.tsx renders NG+ badge on dungeon tiles" || fail "App.tsx missing NG+ badge"
# NG+ carry-over completeness: all 8 gear fields must be present in CreateDungeonReq and carry-over block
grep -q "BootsBonus" backend/internal/handlers/handlers.go && pass "Backend CreateDungeonReq includes BootsBonus for NG+ carry-over" || fail "BootsBonus missing from CreateDungeonReq — boots not carried over on NG+"
grep -q "bootsBonus.*req\.BootsBonus\|req\.BootsBonus.*bootsBonus" backend/internal/handlers/handlers.go && pass "Backend applies BootsBonus to dungeonSpec in CreateDungeon" || fail "BootsBonus not applied to dungeonSpec"
grep -q "bootsBonus" frontend/src/App.tsx && pass "Frontend handleNewGamePlus sends bootsBonus" || fail "Frontend missing bootsBonus in handleNewGamePlus call"
grep -q "RingBonus" backend/internal/handlers/handlers.go && pass "Backend CreateDungeonReq includes RingBonus for NG+ carry-over" || fail "RingBonus missing from CreateDungeonReq — ring not carried over on NG+"
grep -q "ringBonus.*req\.RingBonus\|req\.RingBonus.*ringBonus" backend/internal/handlers/handlers.go && pass "Backend applies RingBonus to dungeonSpec in CreateDungeon" || fail "RingBonus not applied to dungeonSpec"
grep -q "ringBonus" frontend/src/App.tsx && pass "Frontend handleNewGamePlus sends ringBonus" || fail "Frontend missing ringBonus in handleNewGamePlus call"
grep -q "AmuletBonus" backend/internal/handlers/handlers.go && pass "Backend CreateDungeonReq includes AmuletBonus for NG+ carry-over" || fail "AmuletBonus missing from CreateDungeonReq — amulet not carried over on NG+"
grep -q "amuletBonus.*req\.AmuletBonus\|req\.AmuletBonus.*amuletBonus" backend/internal/handlers/handlers.go && pass "Backend applies AmuletBonus to dungeonSpec in CreateDungeon" || fail "AmuletBonus not applied to dungeonSpec"
grep -q "amuletBonus" frontend/src/App.tsx && pass "Frontend handleNewGamePlus sends amuletBonus" || fail "Frontend missing amuletBonus in handleNewGamePlus call"

# --- Boss loot invariants ---
echo "=== Boss loot invariants"
# Boss loot is now computed by kro's combatResolve/boss-graph — verify it's in the RGDs
grep -q "boss-typ\|boss.*loot\|bossLoot\|boss-rar" manifests/rgds/dungeon-graph.yaml manifests/rgds/boss-graph.yaml 2>/dev/null && pass "Boss loot logic lives in kro RGDs (not Go backend)" || fail "Boss loot not found in RGDs"
# Verify Go backend does NOT contain loot computation functions (clean separation)
! grep -q "computeBossLoot\|computeMonsterLoot\|kroSeededRoll\|seededRoll" backend/internal/handlers/handlers.go && pass "Go backend has no loot/RNG math (kro is authoritative)" || fail "Go backend still contains loot/RNG math functions — not fully cleaned up"
# classMaxHP must cover all 3 valid hero classes — ensure no fallthrough for known classes
grep -q '"warrior"' backend/internal/handlers/handlers.go && grep -q '"mage"' backend/internal/handlers/handlers.go && grep -q '"rogue"' backend/internal/handlers/handlers.go && pass "classMaxHP covers all 3 hero classes (warrior/mage/rogue)" || fail "classMaxHP missing a hero class branch"

# --- Mana potion class guard ---
echo "=== Mana potion class guard"
grep -zq 'manapotion.*mage\|heroClass.*mage.*mana\|mana.*heroClass.*mage\|"manapotion-[a-z]*":[[:space:]]*$' backend/internal/handlers/handlers.go && grep -q 'heroClass != "mage"' backend/internal/handlers/handlers.go && pass "Backend rejects mana potions for non-Mage heroes" || fail "Backend missing mana potion class guard"

# --- Leaderboard guardrails ---
echo "=== Leaderboard guardrails"
grep -q "recordLeaderboard\|krombat-leaderboard" backend/internal/handlers/handlers.go && pass "Backend implements leaderboard recording" || fail "Backend missing leaderboard recording"
grep -q "GetLeaderboard" backend/internal/handlers/handlers.go && pass "Backend implements GetLeaderboard handler" || fail "GetLeaderboard handler missing"
grep -q "GetLeaderboard" backend/cmd/main.go && pass "GetLeaderboard handler registered in main.go" || fail "GetLeaderboard not registered in routes"
grep -q "leaderboard-btn\|LeaderboardPanel" frontend/src/App.tsx && pass "Frontend renders leaderboard UI" || fail "Frontend leaderboard UI missing"
grep -q "getLeaderboard" frontend/src/api.ts && pass "Frontend api.ts exports getLeaderboard function" || fail "getLeaderboard missing from api.ts"
# Max entries guard
grep -q "leaderboardMaxEntries\|100" backend/internal/handlers/handlers.go && pass "Leaderboard has max-entries cap to prevent unbounded ConfigMap growth" || fail "Leaderboard missing max-entries cap"

# --- Mini-map guardrails ---
echo "=== Mini-map guardrails"
grep -q "DungeonMiniMap\|dungeon-minimap" frontend/src/App.tsx && pass "App.tsx renders DungeonMiniMap component" || fail "DungeonMiniMap missing from App.tsx"
grep -q "dungeon-minimap" frontend/src/index.css && pass "Mini-map CSS class defined in index.css" || fail "Mini-map CSS missing from index.css"

# --- CEL teaching guardrails ---
echo "=== CEL teaching guardrails"
grep -q "cel-filter" frontend/src/KroTeach.tsx && pass "KroTeach.tsx defines cel-filter concept" || fail "cel-filter concept missing from KroTeach.tsx"
grep -q "cel-string-ops" frontend/src/KroTeach.tsx && pass "KroTeach.tsx defines cel-string-ops concept" || fail "cel-string-ops concept missing from KroTeach.tsx"
grep -q "cel-playground-unlocked" frontend/src/KroTeach.tsx && pass "KroTeach.tsx maps cel-playground-unlocked event" || fail "cel-playground-unlocked event missing from KroTeach.tsx"
grep -q "playgroundFiredRef\|cel-playground-unlocked" frontend/src/App.tsx && pass "App.tsx auto-triggers cel-playground at 10 concepts" || fail "App.tsx missing cel-playground auto-trigger"
grep -q "all-monsters-dead" frontend/src/App.tsx && pass "App.tsx triggers all-monsters-dead for status-aggregation" || fail "all-monsters-dead event missing from App.tsx"
grep -q "loot-drop-string-ops" frontend/src/App.tsx && pass "App.tsx triggers loot-drop-string-ops for cel-string-ops" || fail "loot-drop-string-ops event missing from App.tsx"

# --- KroGraph Inspector guardrails ---
echo "=== KroGraph Inspector guardrails"
grep -q "'hero-cm'" frontend/src/KroGraph.tsx && pass "KroGraph kindMap uses hero-cm (correct node ID)" || fail "KroGraph kindMap still has stale hero-state key"
grep -q "'boss-cm'" frontend/src/KroGraph.tsx && pass "KroGraph kindMap uses boss-cm (correct node ID)" || fail "KroGraph kindMap still has stale boss-state key"
grep -q "'gameconfig-cm'" frontend/src/KroGraph.tsx && pass "KroGraph kindMap uses gameconfig-cm (correct node ID)" || fail "KroGraph kindMap still has stale game-config key"
grep -q "'modifier-cm'" frontend/src/KroGraph.tsx && pass "KroGraph kindMap includes modifier-cm" || fail "KroGraph kindMap missing modifier-cm"
grep -q "helmetBonus\|pantsBonus\|bootsBonus" frontend/src/KroGraph.tsx && pass "KroGraph RGD diff viewer tracks all item bonus fields" || fail "KroGraph missing helmet/pants/boots in diff viewer"
grep -q "modifiercm\|combatcm" frontend/src/api.ts && pass "api.ts VALID_RESOURCE_KINDS includes modifiercm/combatcm" || fail "api.ts missing modifiercm or combatcm kinds"

# --- Dead code guardrails ---
echo "=== Dead code guardrails"
grep -q "^function EntityCard\b" frontend/src/App.tsx && fail "EntityCard dead code not removed from App.tsx" || pass "EntityCard dead code removed from App.tsx"

# --- Security P1 guardrails (#408, #409, #410, #411, #413, #414) ---
echo "=== Security P1 guardrails"

# #408: per-user dungeon creation limit must be enforced
grep -q "maxDungeonsPerUser\|dungeon limit reached" backend/internal/handlers/handlers.go && pass "#408: per-user dungeon creation limit present in CreateDungeon" || fail "#408: per-user dungeon creation limit missing from CreateDungeon"
grep -q "StatusConflict\|http.StatusConflict" backend/internal/handlers/handlers.go && pass "#408: dungeon limit returns HTTP 409 Conflict" || fail "#408: dungeon limit not returning 409 Conflict"

# #409: ownership check in processCombat and processAction
# requireDungeonOwner must be called at least 4 times (GetDungeon, DeleteDungeon, processCombat, processAction)
OWNER_COUNT=$(grep -c "requireDungeonOwner" backend/internal/handlers/handlers.go 2>/dev/null || echo 0)
[ "$OWNER_COUNT" -ge 4 ] && pass "#409: requireDungeonOwner called in 4+ handlers (processCombat/processAction covered)" || fail "#409: requireDungeonOwner only called $OWNER_COUNT times — processCombat/processAction may be missing it (need 4+)"

# #410: GetDungeonResource must check auth + ownership, and must NOT have kind=namespace
grep -q "case \"namespace\"" backend/internal/handlers/handlers.go && fail "#410: kind=namespace still present in GetDungeonResource (security risk)" || pass "#410: kind=namespace removed from GetDungeonResource"
# requireDungeonOwner must appear after GetDungeonResource (line numbers: GetDungeonResource is the last large handler)
OWNER_LINES=$(grep -n "requireDungeonOwner" backend/internal/handlers/handlers.go | cut -d: -f1)
RESOURCE_LINE=$(grep -n "func.*GetDungeonResource" backend/internal/handlers/handlers.go | head -1 | cut -d: -f1)
echo "$OWNER_LINES" | awk -v r="$RESOURCE_LINE" '$1 > r {found=1} END {exit !found}' && pass "#410: requireDungeonOwner called in GetDungeonResource" || fail "#410: ownership check missing from GetDungeonResource"
CELEVAL_LINE=$(grep -n "func.*CelEvalHandler" backend/internal/handlers/handlers.go | head -1 | cut -d: -f1)
echo "$OWNER_LINES" | awk -v c="$CELEVAL_LINE" '$1 > c && $1 < c+60 {found=1} END {exit !found}' && pass "#411: requireDungeonOwner called in CelEvalHandler" || fail "#411: ownership check missing from CelEvalHandler"
grep -A50 "func.*CelEvalHandler" backend/internal/handlers/handlers.go | grep -q "authentication required\|StatusUnauthorized" && pass "#411: auth check present in CelEvalHandler" || fail "#411: auth check missing from CelEvalHandler"
grep -A50 "func.*CelEvalHandler" backend/internal/handlers/handlers.go | grep -q "maxExprLen\|expression too long" && pass "#411: expression length limit present in CelEvalHandler" || fail "#411: expression complexity limit missing from CelEvalHandler"
grep -A50 "func.*GetDungeonResource" backend/internal/handlers/handlers.go | grep -q "authentication required\|StatusUnauthorized" && pass "#410: auth check present in GetDungeonResource" || fail "#410: auth check missing from GetDungeonResource"

# #413: alpine/k8s in dungeon-reaper must be pinned to digest
grep -q "@sha256:" manifests/system/dungeon-reaper.yaml && pass "#413: dungeon-reaper alpine/k8s image pinned to SHA256 digest" || fail "#413: dungeon-reaper alpine/k8s image still uses mutable tag (no @sha256:)"

# #414: trivy-action must NOT use @master (mutable branch)
grep -q "trivy-action@master" .github/workflows/build-images.yml && fail "#414: trivy-action@master still used (mutable — supply chain risk)" || pass "#414: trivy-action not using @master"
grep -q "exit-code: '0'" .github/workflows/build-images.yml && fail "#414: Trivy exit-code is 0 — CVEs silently pass CI" || pass "#414: Trivy exit-code not 0 (CVEs will fail CI)"

# --- Summary ---

echo ""
echo "========================================"
echo "  Guardrail Tests: $PASS passed, $FAIL failed"
echo "========================================"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
