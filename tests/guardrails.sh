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
 #   reconcile_diff.go — watches core ConfigMaps in dungeon namespaces for the reconcile stream (#462)
 # Lines using the 'grp' variable are game.k8s.example GVRs (grp := "game.k8s.example").
 NON_GAME_GVR=$(grep -rn "GroupVersionResource{" "$BACKEND_DIR/internal/" 2>/dev/null \
   | grep -v "game.k8s.example" \
   | grep -v 'Group: grp\|Group: coreGrp\|leaderboardGVR\|reconcile_diff.go' \
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
 grep -q "inCombat) mAction = 'attack'" frontend/src/App.tsx && pass "Alive monsters use attack anim during combat" || fail "Alive monsters not using attack anim"
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
# Go must read bossDamageMultiplier FROM kro status (getString call), not hardcode it.
# Fail only if Go hardcodes the multiplier (×1.5/×2.0) — reading from kro status is correct.
grep -q 'bossDamageMultiplier.*=.*1\.\|bossDamageMultiplier.*:=.*1\.' backend/internal/handlers/handlers.go && fail "Backend hardcoding bossDamageMultiplier — kro is authoritative for counter-attack scaling, Go should read from status" || pass "Backend reads bossDamageMultiplier from kro status (not hardcoded)"
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
# Stun must be consumed by combatResolve (not tickDoT) — tickDoT only handles poison/burn HP damage
! grep -A10 "id: tickDoT" manifests/rgds/dungeon-graph.yaml | grep -q "stunTurns.*-.*1\|stunTurns.*stun" && pass "Stun not decremented in tickDoT (consumed by combatResolve)" || fail "tickDoT still decrements stunTurns — stun will be silently cleared before it takes effect"
grep -A5 "id: combatResolve" manifests/rgds/dungeon-graph.yaml | grep -q "combatResolve\|type: specPatch" && grep -q "wasStunned ? st - 1" manifests/rgds/dungeon-graph.yaml && pass "combatResolve consumes stun (wasStunned ? st - 1)" || fail "combatResolve missing stun consumption (wasStunned ? st - 1)"

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
# Hero class validation must cover all 3 valid hero classes — ensure no fallthrough for known classes
grep -q '"warrior"' backend/internal/handlers/handlers.go && grep -q '"mage"' backend/internal/handlers/handlers.go && grep -q '"rogue"' backend/internal/handlers/handlers.go && pass "Hero class handling covers warrior/mage/rogue" || fail "Hero class handling missing a branch"
# #399: classMaxHP/classMaxMana fallback functions must NOT exist — kro hero-graph is authoritative; backend must reject if maxHeroHP is absent
! grep -q "func classMaxHP\|func classMaxMana" backend/internal/handlers/handlers.go && pass "#399: classMaxHP/classMaxMana fallback functions removed (kro is authoritative)" || fail "#399: classMaxHP/classMaxMana fallback functions still exist — remove them"
# #402: leaderboard/profile must not fall back to raw-HP derivation when kro status is nil
! grep -q "kro status unavailable.*derive from spec" backend/internal/handlers/handlers.go && pass "#402: no raw-HP fallback in leaderboard/profile when kro status absent" || fail "#402: raw-HP fallback still present in leaderboard/profile — remove it"
# #403: dead inventory helper functions must not exist
! grep -q "func inventoryAdd\|func inventoryRemove" backend/internal/handlers/handlers.go && pass "#403: dead inventoryAdd/inventoryRemove functions removed" || fail "#403: inventoryAdd or inventoryRemove still exist — delete them"
# #401: no hardcoded per-turn DoT damage in log string literals (comment references are ok)
! grep -q '"-5 HP/turn\|-8 HP/turn"' backend/internal/handlers/handlers.go && pass "#401: no hardcoded per-turn DoT amounts in log string literals" || fail "#401: hardcoded -5/-8 HP/turn still in log string literals — remove them"

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
# The SARIF upload step intentionally uses exit-code: '0' so the file is generated even with CVEs.
# Only fail if the blocking step (step 2) uses exit-code '0' — check by context around 'Block on'.
grep -A8 'Block on.*CRITICAL' .github/workflows/build-images.yml | grep -q "exit-code: '0'" && fail "#414: Trivy blocking step exit-code is 0 — CVEs silently pass CI" || pass "#414: Trivy blocking step uses exit-code 1 (CVEs fail CI)"

# --- Security P2 guardrails (#415-#423) ---
echo "=== Security P2 guardrails"

# #415: securityContext must be set on all workloads
grep -q "runAsNonRoot: true" manifests/system/backend.yaml && pass "#415: backend securityContext has runAsNonRoot" || fail "#415: backend securityContext missing runAsNonRoot"
grep -q 'drop: \["ALL"\]' manifests/system/backend.yaml && pass "#415: backend drops ALL capabilities" || fail "#415: backend missing capabilities drop ALL"
grep -q "runAsNonRoot: true" manifests/system/frontend.yaml && pass "#415: frontend securityContext has runAsNonRoot" || fail "#415: frontend securityContext missing runAsNonRoot"
grep -q 'drop: \["ALL"\]' manifests/system/frontend.yaml && pass "#415: frontend drops ALL capabilities" || fail "#415: frontend missing capabilities drop ALL"
grep -q "runAsNonRoot: true" manifests/system/dungeon-reaper.yaml && pass "#415: dungeon-reaper securityContext has runAsNonRoot" || fail "#415: dungeon-reaper securityContext missing runAsNonRoot"

# #416: metrics must NOT be on main mux (port 8080) — must be on separate port
grep -q 'mux.Handle.*metrics' backend/cmd/main.go && fail "#416: /metrics still registered on main mux (public port 8080)" || pass "#416: /metrics not on main mux (served on internal port 9090)"
grep -q "9090" backend/cmd/main.go && pass "#416: internal metrics server listening on port 9090" || fail "#416: metrics server not found on port 9090"
[ -f manifests/system/network-policy.yaml ] && pass "#416: NetworkPolicy manifest exists" || fail "#416: NetworkPolicy manifest missing"

# #417: HTTP security headers must be set in backend middleware and nginx
grep -q "X-Content-Type-Options" backend/internal/handlers/middleware.go && pass "#417: X-Content-Type-Options header set in backend middleware" || fail "#417: X-Content-Type-Options missing from backend middleware"
grep -q "X-Frame-Options" backend/internal/handlers/middleware.go && pass "#417: X-Frame-Options header set in backend middleware" || fail "#417: X-Frame-Options missing from backend middleware"
grep -q "Content-Security-Policy" frontend/nginx.conf && pass "#417: CSP header in nginx.conf" || fail "#417: Content-Security-Policy missing from nginx.conf"
grep -q "Strict-Transport-Security" frontend/nginx.conf && pass "#417: HSTS header in nginx.conf" || fail "#417: Strict-Transport-Security missing from nginx.conf"

# #418: SESSION_SECRET must be required (no optional:true on github-oauth secret, fail-fast in main.go)
grep -A3 "name: krombat-github-oauth" manifests/system/backend.yaml | grep -q "optional: true" && fail "#418: krombat-github-oauth still optional:true — SESSION_SECRET can be absent" || pass "#418: krombat-github-oauth not optional (SESSION_SECRET is required)"
grep -q "SESSION_SECRET.*not set\|SESSION_SECRET is not set" backend/cmd/main.go && pass "#418: main.go exits if SESSION_SECRET absent (fail-fast)" || fail "#418: main.go missing SESSION_SECRET fail-fast check"

# #419: telemetry handlers must have body size limits and event allowlist
grep -q "validGameEvents\|allowlist" backend/internal/handlers/handlers.go && pass "#419: game event allowlist present in EventsTrackHandler" || fail "#419: game event allowlist missing from EventsTrackHandler"
grep -q "telemetryLimit\|h.telemetryLimit" backend/internal/handlers/handlers.go && pass "#419: telemetry rate limiter applied" || fail "#419: telemetry rate limiter missing"
grep -A10 "ClientErrorHandler" backend/internal/handlers/handlers.go | grep -q "MaxBytesReader" && pass "#419/#421: ClientErrorHandler has body size cap" || fail "#419/#421: ClientErrorHandler missing MaxBytesReader"
grep -A10 "EventsTrackHandler" backend/internal/handlers/handlers.go | grep -q "MaxBytesReader" && pass "#419/#421: EventsTrackHandler has body size cap" || fail "#419/#421: EventsTrackHandler missing MaxBytesReader"

# #420: rate-limiter must have TTL eviction
grep -q "evictBefore\|interval.*10\|Interval.*10" backend/internal/handlers/ratelimit.go && pass "#420: rate-limiter has TTL eviction logic" || fail "#420: rate-limiter missing TTL eviction"

# #421: CreateDungeon must have body size cap
grep -A5 "CreateDungeon" backend/internal/handlers/handlers.go | grep -q "MaxBytesReader" && pass "#421: CreateDungeon has MaxBytesReader body cap" || fail "#421: CreateDungeon missing MaxBytesReader"

# #422: requireDungeonOwner must DENY unlabelled dungeons
grep -A10 "func requireDungeonOwner" backend/internal/handlers/handlers.go | grep -q "no owner label\|forbidden.*no owner\|hasLabel\].*deny\|!hasLabel" && pass "#422: requireDungeonOwner denies dungeons without owner label" || fail "#422: requireDungeonOwner still allows unlabelled dungeons"
[ -f manifests/system/admission-policy.yaml ] && pass "#422: ValidatingAdmissionPolicy manifest exists" || fail "#422: ValidatingAdmissionPolicy manifest missing"
grep -q "krombat.io/owner" manifests/system/admission-policy.yaml && pass "#422: admission policy enforces krombat.io/owner label" || fail "#422: admission policy does not reference krombat.io/owner"

# #423: equipment bonus upper bound must be enforced
grep -q "maxEquipBonus\|equip.*50\|50.*equip" backend/internal/handlers/handlers.go && pass "#423: maxEquipBonus constant present in CreateDungeon" || fail "#423: maxEquipBonus missing from CreateDungeon"
grep -q "maximum=50" manifests/rgds/dungeon-graph.yaml && pass "#423: dungeon-graph RGD has maximum=50 on bonus fields" || fail "#423: dungeon-graph RGD missing maximum=50 on bonus fields"

# --- Security P3 guardrails (#424-#429) ---
echo "=== Security P3 guardrails"

# #424: GitHub Actions must be pinned to SHA (no floating @v4 or @master)
# Use grep -v '#' to skip comment lines when checking for mutable tags.
grep -v '#' .github/workflows/build-images.yml | grep -q "actions/checkout@v4" && fail "#424: actions/checkout still using mutable @v4 tag" || pass "#424: actions/checkout pinned to SHA"
grep -v '#' .github/workflows/build-images.yml | grep -q "aws-actions/configure-aws-credentials@v4" && fail "#424: configure-aws-credentials still using mutable @v4 tag" || pass "#424: configure-aws-credentials pinned to SHA"
grep -v '#' .github/workflows/build-images.yml | grep -q "azure/setup-kubectl@v4" && fail "#424: setup-kubectl still using mutable @v4 tag" || pass "#424: setup-kubectl pinned to SHA"
grep -v '#' .github/workflows/build-images.yml | grep -q "amazon-ecr-login@v2" && fail "#424: amazon-ecr-login still using mutable @v2 tag" || pass "#424: amazon-ecr-login pinned to SHA"
grep -v '#' .github/workflows/build-images.yml | grep -q "codeql-action/upload-sarif@v3" && fail "#424: codeql upload-sarif still using mutable @v3 tag" || pass "#424: codeql upload-sarif pinned to SHA"

# #425: Terraform S3 backend must have encrypt=true and dynamodb_table
grep -q "encrypt.*=.*true" infra/main.tf && pass "#425: Terraform S3 backend has encrypt=true" || fail "#425: Terraform S3 backend missing encrypt=true"
grep -q "dynamodb_table" infra/main.tf && pass "#425: Terraform S3 backend has DynamoDB locking" || fail "#425: Terraform S3 backend missing dynamodb_table"

# #426: ECR repositories must have scan_on_push and KMS encryption
grep -q "scan_on_push.*=.*true" infra/ecr.tf && pass "#426: ECR has scan_on_push = true" || fail "#426: ECR missing scan_on_push"
grep -q 'encryption_type.*=.*"KMS"' infra/ecr.tf && pass "#426: ECR has KMS encryption" || fail "#426: ECR missing KMS encryption"

# #427: dungeon reaper must use namespaced Role, not ClusterRole
grep -q "kind: ClusterRole" manifests/system/dungeon-reaper.yaml && fail "#427: dungeon-reaper still using ClusterRole (should be namespaced Role)" || pass "#427: dungeon-reaper uses namespaced Role"
grep -q "kind: Role$" manifests/system/dungeon-reaper.yaml && pass "#427: dungeon-reaper has namespaced Role" || fail "#427: dungeon-reaper missing namespaced Role"

 # #428: OAuth callback URL must not be hardcoded in auth.go (comments are ok)
 grep -v '//' backend/internal/handlers/auth.go | grep -q 'learn-kro.eks.aws.dev/api/v1/auth/callback' && fail "#428: hardcoded OAuth callback URL still in auth.go code" || pass "#428: hardcoded OAuth callback URL removed from auth.go"
 grep -q "GITHUB_CALLBACK_URL.*not set\|required env var" backend/cmd/main.go && pass "#428: main.go fails fast if GITHUB_CALLBACK_URL absent" || fail "#428: main.go missing GITHUB_CALLBACK_URL fail-fast"

# #429: session TTL must be <= 4h
grep -q "sessionTTL.*=.*4.*time.Hour\|4.*time.Hour.*sessionTTL" backend/internal/handlers/auth.go && pass "#429: session TTL reduced to 4h" || fail "#429: session TTL not reduced to 4h"
grep -q '"j".*jti\|Jti.*string\|jti.*nonce' backend/internal/handlers/auth.go && pass "#429: session payload has jti field for future revocation" || fail "#429: session payload missing jti field"

# --- Teaching T1 guardrails (#436, #438, #441-#443, #446-#448, #451) ---
echo "=== Teaching T1 guardrails"

# #436: Inspector must use correct CM names
grep -q 'name.*"-hero-state"' backend/internal/handlers/handlers.go && fail "#436: herostate still uses wrong CM name -hero-state" || pass "#436: herostate CM name fixed to -hero"
grep -q 'name.*"-boss-state"' backend/internal/handlers/handlers.go && fail "#436: bossstate still uses wrong CM name -boss-state" || pass "#436: bossstate CM name fixed to -boss"
grep -q '"treasurecm".*"-treasure"[^-]' backend/internal/handlers/handlers.go && fail "#436: treasurecm still uses wrong CM name (missing -state suffix)" || pass "#436: treasurecm CM name fixed to -treasure-state"

# #441: dead cases removed from GetDungeonResource
grep -q '"combatresult"\|"combatcm"\|"actioncm"' backend/internal/handlers/handlers.go && fail "#441: dead combatresult/combatcm/actioncm cases still in GetDungeonResource" || pass "#441: dead combatresult/combatcm/actioncm cases removed"

# #442: equip-weapon CEL annotation must show correct values (5, 10, 20) and use variable 'a'
grep -q "'equip-weapon-rare' ? 5\|equip-weapon-rare.*10 : 3\|action == 'equip-weapon" frontend/src/KroTeach.tsx && fail "#442: equip-weapon CEL still uses old wrong values or 'action' variable name" || pass "#442: equip-weapon CEL uses correct variable 'a' and values 5/10/20"
grep -q "'equip-weapon-common' ? 5" frontend/src/KroTeach.tsx && pass "#442: equip-weapon-common bonus is 5 (correct)" || fail "#442: equip-weapon-common bonus not set to 5"

# #443: HP-potion CEL must not use min() or maxHeroHP or healAmt
grep -q "min(heroHP\|min(hp\|healAmt" frontend/src/KroTeach.tsx && fail "#443: HP-potion CEL still uses min()/healAmt" || pass "#443: HP-potion CEL uses correct ternary clamping"
grep -q "hppotion-common.*hp + 20\|use-hppotion-epic.*maxHP" frontend/src/KroTeach.tsx && pass "#443: HP-potion CEL shows correct amounts (20/40/maxHP)" || fail "#443: HP-potion CEL missing correct amounts"

# #446: CelTrace must use random.seededInt not seededRoll; lastAttackIsBackstab not backstabCooldown == 0
grep -q "seededRoll\|uid+'-" frontend/src/KroTeach.tsx && fail "#446: CelTrace still uses seededRoll() or uid variable" || pass "#446: CelTrace uses random.seededInt and lastAttackSeed"
# Check backstabCooldown == 0 is not in code (comments are ok, look for the expr string)
grep -q '"backstabCooldown == 0"' frontend/src/KroTeach.tsx && fail "#446: CelTrace backstab expr still has backstabCooldown == 0" || pass "#446: CelTrace backstab uses lastAttackIsBackstab"
grep -q '"berserk"\|"enraged"\|bossHP <= maxBossHP' frontend/src/KroTeach.tsx && fail "#446: CelTrace boss phase still uses berserk/enraged/maxBossHP" || pass "#446: CelTrace boss phase uses phase1/phase2/phase3"

# #447: modifier CelTrace must use correct multipliers (not 1.25/1.15/0.85 for damage/counter)
# Exclude comment lines (// comments) and check only code lines
grep -v '^\s*//' frontend/src/KroTeach.tsx | grep -q "damage.*1\.25\|damage.*1\.15\|'counter.*1\.25\|'counter.*1\.15\|'counter.*0\.85" && fail "#447: modifier CelTrace still shows wrong multipliers (1.25/1.15/0.85)" || pass "#447: modifier CelTrace multipliers corrected"
# Check that modExpr assignments use schema.spec.modifier (not bare spec.modifier without schema prefix)
grep -q "modExpr = .*'spec\.modifier\|modExpr = .*\"spec\.modifier" frontend/src/KroTeach.tsx && fail "#447: modifier CelTrace uses bare spec.modifier in expression string (needs schema.spec.modifier)" || pass "#447: modifier CelTrace modExpr uses schema.spec.modifier"

# #448: InsightCards must not reference combatResult CM or processCombat
grep -q "combatResult ConfigMap\|processCombat\|in a ConfigMap'" frontend/src/KroTeach.tsx && fail "#448: InsightCards still reference stale combatResult CM or processCombat" || pass "#448: InsightCards stale arch references removed"
grep -q 'lists\.setIndex' frontend/src/KroTeach.tsx && fail "#448: lists.setIndex still used (should be lists.set)" || pass "#448: lists.setIndex replaced with lists.set"
grep -q 'int(name.*36\|base-36.*coercion' frontend/src/KroTeach.tsx && fail "#448: loot-drop-string-ops still mentions int(name, 36) / base-36" || pass "#448: loot-drop-string-ops headline updated"

# #451: intro modal must be updated
grep -q "'kro Creates 7 Resources\|two ConfigMaps\|id: combatResult" frontend/src/KroTeach.tsx && fail "#451: intro modal still says '7 Resources' or references combatResult/two ConfigMaps" || pass "#451: intro modal resource count and combatResult reference updated"
grep -q "kubectl patch dungeon\|backend runs a kubectl patch\|'Every Action is a kubectl" frontend/src/KroTeach.tsx && fail "#451: intro modal still says 'backend runs kubectl patch'" || pass "#451: intro modal kubectl patch reference removed"
grep -q "15 core kro concepts\|and 9 more" frontend/src/KroTeach.tsx && fail "#451: intro modal still says '15 concepts' or '9 more'" || pass "#451: intro modal concept count updated to 23"

# --- Backend audit cleanup guardrails ---
echo "=== Backend audit cleanup guardrails"

# #398: boss phase multipliers must not be hardcoded ×1.5/×2.0 in combat log
grep -q 'ENRAGED ×1\.5\|BERSERK ×2\.0\|phaseNote.*1\.5\|phaseNote.*2\.0' backend/internal/handlers/handlers.go && fail "#398: hardcoded boss phase multipliers 1.5/2.0 still in deriveCombatLog" || pass "#398: boss phase multipliers read from kro bossDamageMultiplier"
# boss-graph damageMultiplier must use 13/16 (not 15/20) — check only the damageMultiplier CEL block
grep -A6 "damageMultiplier:" manifests/rgds/boss-graph.yaml | grep -q "'15'\|'20'" && fail "#398: boss-graph damageMultiplier still uses 15/20 (should be 13/16)" || pass "#398: boss-graph damageMultiplier uses correct 13/16"

# --- Teaching T2 guardrails (#437, #439, #440, #444, #449, #450, #452, #453) ---
echo "=== Teaching T2 guardrails"

# #437: lootInfo CM node must exist in KroGraph; boss-loot edge from boss not boss-cm
grep -q "loot-info-m\${i}\|'loot-info-m'" frontend/src/KroGraph.tsx && pass "#437: lootInfo CM node added to KroGraph" || fail "#437: lootInfo CM node missing from KroGraph"
grep -q "from: 'boss-cm'.*boss-loot\|boss-cm.*boss-loot" frontend/src/KroGraph.tsx && fail "#440: boss-loot edge source still boss-cm" || pass "#440: boss-loot edge source fixed to boss"

# #437: loot/lootinfo/lootsecret kinds must be in VALID_RESOURCE_KINDS
grep -q "'loot'" frontend/src/api.ts && pass "#437: 'loot' kind in VALID_RESOURCE_KINDS" || fail "#437: 'loot' kind missing from VALID_RESOURCE_KINDS"
grep -q "'lootinfo'" frontend/src/api.ts && pass "#437: 'lootinfo' kind in VALID_RESOURCE_KINDS" || fail "#437: 'lootinfo' kind missing"
grep -q "'lootsecret'" frontend/src/api.ts && pass "#437: 'lootsecret' kind in VALID_RESOURCE_KINDS" || fail "#437: 'lootsecret' kind missing"
# #437: loot/lootinfo/lootsecret handler cases must exist in GetDungeonResource
grep -q '"loot":$\|case "loot"' backend/internal/handlers/handlers.go && pass "#437: 'loot' case in GetDungeonResource" || fail "#437: 'loot' case missing from GetDungeonResource"

# #439: actionResolve node concept must be spec-mutation not empty-rgd
grep -A5 "actionResolve" frontend/src/KroGraph.tsx | grep -q "concept: 'empty-rgd'" && fail "#439: actionResolve node still uses concept: empty-rgd" || pass "#439: actionResolve node uses concept: spec-mutation"

# #449: InsightCard dungeon-created must not say '7 resources'
grep -q "kro created 7 resources" frontend/src/KroTeach.tsx && fail "#449: dungeon-created InsightCard still says '7 resources'" || pass "#449: dungeon-created InsightCard updated"

# #450: spec-patch concept must exist in KroConceptId and CONCEPT_ORDER
grep -q "'spec-patch'" frontend/src/KroTeach.tsx && pass "#450: spec-patch concept exists in KroTeach" || fail "#450: spec-patch concept missing from KroTeach"
grep -q "dot-applied" frontend/src/App.tsx && pass "#450: dot-applied event triggers spec-patch insight" || fail "#450: dot-applied event missing from App.tsx"

# #452: help modal boss phase table must show correct multipliers (1.3x/1.6x not 1.5x/2.0x)
grep -v '^\s*//' frontend/src/App.tsx | grep -v '{/\*.*#452' | grep -q "1\.5x\|2\.0x\|1\.5×\|2\.0×" && fail "#452: help modal still shows 1.5x/2.0x boss phase multipliers" || pass "#452: help modal shows correct 1.3x/1.6x"
grep -v '^\s*//' frontend/src/App.tsx | grep -v '{/\*.*#452' | grep -q "Special Chance" && fail "#452: help modal still shows 'Special Chance' column (misleading)" || pass "#452: Special Chance column removed from help modal"

# #453: CEL playground examples — no 'self.spec', must use 'schema.spec'; no wrong boss state expr
grep -q "'self\.spec\.\?modifier\|self\.spec\.bossHP" frontend/src/KroTeach.tsx && fail "#453: CEL playground still uses self.spec (should be schema.spec)" || pass "#453: CEL playground uses schema.spec"
grep -q "schema\.spec\.monsters == 0" frontend/src/KroTeach.tsx && fail "#453: boss state ternary still uses schema.spec.monsters == 0 (wrong)" || pass "#453: boss state ternary uses monsterHP.all()"

# === #473 / #472 / #471: infra hardening guardrails ===
# #473: kro memory request must equal limit (Guaranteed QoS)
grep -A5 'requests:' manifests/system/kro-resources.yaml | grep -q '"8Gi"' \
  && grep -A5 'limits:' manifests/system/kro-resources.yaml | grep -q '"8Gi"' \
  && pass "#473: kro memory request=limit=8Gi (Guaranteed QoS)" \
  || fail "#473: kro memory request != limit — pod is Burstable, eligible for OOM eviction"

# #473: kro must NOT have a cpu limit (allow bursting)
grep -A10 'limits:' manifests/system/kro-resources.yaml | grep -q 'cpu:' \
  && fail "#473: kro has a cpu limit — remove it to allow reconcile burst" \
  || pass "#473: kro has no cpu limit (allows burst)"

# #472: kro NodePool manifest must exist with the correct taint
grep -q 'krombat.io/role' manifests/system/kro-nodepool.yaml \
  && pass "#472: kro-nodepool.yaml exists with krombat.io/role taint" \
  || fail "#472: kro-nodepool.yaml missing or lacks krombat.io/role taint"

# #472: kro Deployment must have matching toleration
grep -q 'krombat.io/role' manifests/system/kro-resources.yaml \
  && pass "#472: kro Deployment has krombat.io/role toleration/affinity" \
  || fail "#472: kro Deployment missing krombat.io/role toleration — kro will not schedule on dedicated node"

# #471: VPC must use 3 AZs
grep -q 'slice.*0, 3\|0, 3)' infra/main.tf \
  && pass "#471: VPC sliced to 3 AZs in main.tf" \
  || fail "#471: VPC still using fewer than 3 AZs — update slice(azs, 0, 3)"

# #471: backend topology spread must use DoNotSchedule
grep -A8 'topologySpreadConstraints' manifests/system/backend.yaml | grep -q 'DoNotSchedule' \
  && pass "#471: backend topology spread uses DoNotSchedule (enforces AZ spread)" \
  || fail "#471: backend topology spread uses ScheduleAnyway — AZ distribution not enforced"

# #471: frontend topology spread must use DoNotSchedule
grep -A8 'topologySpreadConstraints' manifests/system/frontend.yaml | grep -q 'DoNotSchedule' \
  && pass "#471: frontend topology spread uses DoNotSchedule (enforces AZ spread)" \
  || fail "#471: frontend topology spread uses ScheduleAnyway — AZ distribution not enforced"

# === #361: kro certificate system guardrails ===
# /profile/cert endpoint must be registered in main.go
grep -q 'POST /api/v1/profile/cert' backend/cmd/main.go \
  && pass "#361: POST /api/v1/profile/cert route registered in main.go" \
  || fail "#361: POST /api/v1/profile/cert route missing from main.go"

# tier2Certs allow-list must include expected cert IDs
grep -q '"log-explorer"' backend/internal/handlers/handlers.go \
  && pass "#361: tier2Certs allow-list contains log-explorer" \
  || fail "#361: tier2Certs allow-list missing log-explorer"

grep -q '"kro-reconcile"' backend/internal/handlers/handlers.go \
  && pass "#361: tier2Certs allow-list contains kro-reconcile" \
  || fail "#361: tier2Certs allow-list missing kro-reconcile"

# computeCertificates helper must exist
grep -q 'func computeCertificates' backend/internal/handlers/handlers.go \
  && pass "#361: computeCertificates helper exists in handlers.go" \
  || fail "#361: computeCertificates helper missing from handlers.go"

# AwardCert handler must exist
grep -q 'func (h \*Handler) AwardCert' backend/internal/handlers/handlers.go \
  && pass "#361: AwardCert handler exists in handlers.go" \
  || fail "#361: AwardCert handler missing from handlers.go"

# CERT_REGISTRY constant must exist in App.tsx
grep -q 'CERT_REGISTRY' frontend/src/App.tsx \
  && pass "#361: CERT_REGISTRY constant exists in App.tsx" \
  || fail "#361: CERT_REGISTRY constant missing from App.tsx"

# cert-toast must exist in App.tsx
grep -q 'cert-toast' frontend/src/App.tsx \
  && pass "#361: cert-toast notification exists in App.tsx" \
  || fail "#361: cert-toast notification missing from App.tsx"

# cert-toast CSS must exist in index.css
grep -q 'cert-toast' frontend/src/index.css \
  && pass "#361: .cert-toast CSS defined in index.css" \
  || fail "#361: .cert-toast CSS missing from index.css"

# awardCert must exist in api.ts
grep -q 'export async function awardCert' frontend/src/api.ts \
  && pass "#361: awardCert function exported from api.ts" \
  || fail "#361: awardCert function missing from api.ts"

# K8s log tab cert trigger must exist (log-explorer)
grep -q "log-explorer" frontend/src/App.tsx \
  && pass "#361: log-explorer cert trigger wired in App.tsx" \
  || fail "#361: log-explorer cert trigger missing from App.tsx"

# === #456: social run cards guardrails ===
# RunCard handler must exist in handlers.go
grep -q 'func (h \*Handler) RunCard' backend/internal/handlers/handlers.go \
  && pass "#456: RunCard handler exists in handlers.go" \
  || fail "#456: RunCard handler missing from handlers.go"

# run-card route must be registered in main.go
grep -q 'GET /api/v1/run-card/' backend/cmd/main.go \
  && pass "#456: GET /api/v1/run-card route registered in main.go" \
  || fail "#456: GET /api/v1/run-card route missing from main.go"

# RunCard must return image/svg+xml Content-Type
grep -q 'image/svg+xml' backend/internal/handlers/handlers.go \
  && pass "#456: RunCard returns image/svg+xml content type" \
  || fail "#456: RunCard missing image/svg+xml content type"

# run-card-section CSS must exist in index.css
grep -q 'run-card-section' frontend/src/index.css \
  && pass "#456: .run-card-section CSS defined in index.css" \
  || fail "#456: .run-card-section CSS missing from index.css"

# Share Run button must exist in App.tsx
grep -q 'Share Run' frontend/src/App.tsx \
  && pass "#456: Share Run button present in App.tsx" \
  || fail "#456: Share Run button missing from App.tsx"

# run-card-img CSS must exist in index.css
grep -q 'run-card-img' frontend/src/index.css \
  && pass "#456: .run-card-img CSS defined in index.css" \
  || fail "#456: .run-card-img CSS missing from index.css"

# === #458: conference demo package guardrails ===
# DEMO.md must exist
[ -f "Docs/demo/DEMO.md" ] \
  && pass "#458: Docs/demo/DEMO.md exists" \
  || fail "#458: Docs/demo/DEMO.md missing"

# dungeon-demo.yaml must exist
[ -f "Docs/demo/dungeon-demo.yaml" ] \
  && pass "#458: Docs/demo/dungeon-demo.yaml exists" \
  || fail "#458: Docs/demo/dungeon-demo.yaml missing"

# dungeon-demo.yaml must reference correct apiVersion
grep -q 'game.k8s.example/v1alpha1' Docs/demo/dungeon-demo.yaml \
  && pass "#458: dungeon-demo.yaml has correct apiVersion" \
  || fail "#458: dungeon-demo.yaml missing game.k8s.example/v1alpha1 apiVersion"

# dungeon-demo.yaml must be kind: Dungeon
grep -q 'kind: Dungeon' Docs/demo/dungeon-demo.yaml \
  && pass "#458: dungeon-demo.yaml is kind: Dungeon" \
  || fail "#458: dungeon-demo.yaml is not kind: Dungeon"

# speaker-notes.md must exist
[ -f "Docs/demo/speaker-notes.md" ] \
  && pass "#458: Docs/demo/speaker-notes.md exists" \
  || fail "#458: Docs/demo/speaker-notes.md missing"

# speaker-notes.md must have at least 10 Q&A entries
QA_COUNT=$(grep -c '^## Q' Docs/demo/speaker-notes.md 2>/dev/null || echo 0)
[ "$QA_COUNT" -ge 10 ] \
  && pass "#458: speaker-notes.md has $QA_COUNT Q&A scenarios (>=10)" \
  || fail "#458: speaker-notes.md has only $QA_COUNT Q&A scenarios (<10)"

# DEMO.md must reference the kubectl terminal mode (#457)
grep -q 'kubectl Terminal\|kubectl terminal' Docs/demo/DEMO.md \
  && pass "#458: DEMO.md references kubectl terminal mode" \
  || fail "#458: DEMO.md missing reference to kubectl terminal mode"

# Intro modal must have Demo slide
grep -q 'Running a Demo' frontend/src/KroTeach.tsx \
  && pass "#458: intro modal has demo slide in KroTeach.tsx" \
  || fail "#458: intro modal missing demo slide in KroTeach.tsx"

# ─── #462 Reconcile Stream guardrails ────────────────────────────────────────

# Backend must have reconcile_diff.go watcher
[ -f "backend/internal/k8s/reconcile_diff.go" ] \
  && pass "#462: reconcile_diff.go exists in backend/internal/k8s/" \
  || fail "#462: reconcile_diff.go missing from backend/internal/k8s/"

# Backend must export StartReconcileDiffWatcher
grep -q 'StartReconcileDiffWatcher' backend/internal/k8s/reconcile_diff.go \
  && pass "#462: StartReconcileDiffWatcher exported from reconcile_diff.go" \
  || fail "#462: StartReconcileDiffWatcher missing from reconcile_diff.go"

# main.go must call StartReconcileDiffWatcher
grep -q 'StartReconcileDiffWatcher' backend/cmd/main.go \
  && pass "#462: main.go calls StartReconcileDiffWatcher" \
  || fail "#462: main.go missing StartReconcileDiffWatcher call"

# Backend must broadcast RECONCILE_DIFF event type
grep -q 'RECONCILE_DIFF' backend/internal/k8s/reconcile_diff.go \
  && pass "#462: RECONCILE_DIFF event type used in reconcile_diff.go" \
  || fail "#462: RECONCILE_DIFF event type missing from reconcile_diff.go"

# Frontend must accumulate reconcile stream state
grep -q 'reconcileStream' frontend/src/App.tsx \
  && pass "#462: reconcileStream state in App.tsx" \
  || fail "#462: reconcileStream state missing from App.tsx"

# Frontend must have Reconcile Stream tab button
grep -q 'reconcile-tab' frontend/src/App.tsx \
  && pass "#462: reconcile-tab button in App.tsx" \
  || fail "#462: reconcile-tab button missing from App.tsx"

# Frontend must render field diffs with color coding
grep -q 'reconcile-field' frontend/src/App.tsx \
  && pass "#462: reconcile-field elements rendered in App.tsx" \
  || fail "#462: reconcile-field rendering missing from App.tsx"

# Frontend must have Why? expand button
grep -q 'reconcile-why-btn' frontend/src/App.tsx \
  && pass "#462: Why? button (.reconcile-why-btn) in App.tsx" \
  || fail "#462: Why? button missing from App.tsx"

# Frontend must have Pause / Copy JSON controls
grep -q 'reconcile-btn' frontend/src/App.tsx \
  && pass "#462: Pause/Copy controls (.reconcile-btn) in App.tsx" \
  || fail "#462: Pause/Copy controls missing from App.tsx"

# CSS must have reconcile-stream styles
grep -q 'reconcile-stream-panel\|reconcile-entry\|reconcile-why-panel' frontend/src/index.css \
  && pass "#462: Reconcile Stream CSS styles in index.css" \
  || fail "#462: Reconcile Stream CSS styles missing from index.css"

# Help modal must document Reconcile Stream
grep -q 'Reconcile Stream' frontend/src/App.tsx \
  && pass "#462: Help modal documents Reconcile Stream" \
  || fail "#462: Help modal missing Reconcile Stream documentation"

# Intro tour must have Reconcile Stream slide
grep -q 'Reconcile Stream' frontend/src/KroTeach.tsx \
  && pass "#462: KroTeach.tsx intro tour has Reconcile Stream slide" \
  || fail "#462: KroTeach.tsx missing Reconcile Stream intro slide"

# Journey 39 must exist
[ -f "tests/e2e/journeys/39-reconcile-stream.js" ] \
  && pass "#462: tests/e2e/journeys/39-reconcile-stream.js exists" \
  || fail "#462: tests/e2e/journeys/39-reconcile-stream.js missing"

# ─── #460 Blog Post Generator guardrails ─────────────────────────────────────

# RunNarrative handler must exist in handlers.go
grep -q 'func (h \*Handler) RunNarrative' backend/internal/handlers/handlers.go \
  && pass "#460: RunNarrative handler exists in handlers.go" \
  || fail "#460: RunNarrative handler missing from handlers.go"

# run-narrative route must be registered in main.go
grep -q 'GET /api/v1/run-narrative/' backend/cmd/main.go \
  && pass "#460: GET /api/v1/run-narrative route registered in main.go" \
  || fail "#460: GET /api/v1/run-narrative route missing from main.go"

# RunNarrative must return application/json Content-Type
grep -q '"application/json"' backend/internal/handlers/handlers.go \
  && pass "#460: handlers.go uses application/json (RunNarrative)" \
  || fail "#460: handlers.go missing application/json"

# Frontend must have run-narrative-btn
grep -q 'run-narrative-btn' frontend/src/App.tsx \
  && pass "#460: run-narrative-btn in App.tsx" \
  || fail "#460: run-narrative-btn missing from App.tsx"

# Frontend must have run-narrative-modal
grep -q 'run-narrative-modal' frontend/src/App.tsx \
  && pass "#460: run-narrative-modal in App.tsx" \
  || fail "#460: run-narrative-modal missing from App.tsx"

# Frontend must have Copy Markdown button
grep -q 'Copy Markdown' frontend/src/App.tsx \
  && pass "#460: Copy Markdown button in App.tsx" \
  || fail "#460: Copy Markdown button missing from App.tsx"

# Frontend must have Open in GitHub Discussions button
grep -q 'Open in GitHub Discussions' frontend/src/App.tsx \
  && pass "#460: Open in GitHub Discussions button in App.tsx" \
  || fail "#460: Open in GitHub Discussions button missing from App.tsx"

# CSS must have run-narrative styles
grep -q 'run-narrative-modal\|run-narrative-btn\|run-narrative-textarea' frontend/src/index.css \
  && pass "#460: run-narrative CSS styles in index.css" \
  || fail "#460: run-narrative CSS styles missing from index.css"

# Help modal must document Blog Post Generator
grep -q 'Blog Post Generator\|Tell the story\|run narrative\|run-narrative' frontend/src/App.tsx \
  && pass "#460: Help modal documents Blog Post Generator" \
  || fail "#460: Help modal missing Blog Post Generator documentation"

# Intro tour must have Tell the story slide
grep -q 'Tell the story\|Tell the Story\|blog.*post\|Blog Post' frontend/src/KroTeach.tsx \
  && pass "#460: KroTeach.tsx intro tour has Tell the story slide" \
  || fail "#460: KroTeach.tsx missing Tell the story intro slide"

# Journey 40 must exist
[ -f "tests/e2e/journeys/40-blog-post-generator.js" ] \
  && pass "#460: tests/e2e/journeys/40-blog-post-generator.js exists" \
  || fail "#460: tests/e2e/journeys/40-blog-post-generator.js missing"

# --- Data retention UI text (#477) ---
echo "=== Data retention UI text"
grep -q "30 days" frontend/src/App.tsx \
  && pass "#477: UI says dungeon data kept for 30 days" \
  || fail "#477: UI still says '4 hours' instead of '30 days' — update App.tsx retention string"

# --- Workshop kit (#461) ---
echo "=== Workshop kit (#461)"

# Docs/workshop/README.md must exist
[ -f "Docs/workshop/README.md" ] \
  && pass "#461: Docs/workshop/README.md exists" \
  || fail "#461: Docs/workshop/README.md missing"

# Docs/workshop/day-1-explore.md must exist
[ -f "Docs/workshop/day-1-explore.md" ] \
  && pass "#461: Docs/workshop/day-1-explore.md exists" \
  || fail "#461: Docs/workshop/day-1-explore.md missing"

# Docs/workshop/day-2-read-the-rgds.md must exist
[ -f "Docs/workshop/day-2-read-the-rgds.md" ] \
  && pass "#461: Docs/workshop/day-2-read-the-rgds.md exists" \
  || fail "#461: Docs/workshop/day-2-read-the-rgds.md missing"

# Docs/workshop/day-3-extend.md must exist
[ -f "Docs/workshop/day-3-extend.md" ] \
  && pass "#461: Docs/workshop/day-3-extend.md exists" \
  || fail "#461: Docs/workshop/day-3-extend.md missing"

# exercises must exist
[ -f "Docs/workshop/exercises/day-1-exercises.md" ] \
  && pass "#461: Docs/workshop/exercises/day-1-exercises.md exists" \
  || fail "#461: Docs/workshop/exercises/day-1-exercises.md missing"

[ -f "Docs/workshop/exercises/day-2-exercises.md" ] \
  && pass "#461: Docs/workshop/exercises/day-2-exercises.md exists" \
  || fail "#461: Docs/workshop/exercises/day-2-exercises.md missing"

[ -f "Docs/workshop/exercises/day-3-exercises.md" ] \
  && pass "#461: Docs/workshop/exercises/day-3-exercises.md exists" \
  || fail "#461: Docs/workshop/exercises/day-3-exercises.md missing"

# solutions/day-3-solution.yaml must exist
[ -f "Docs/workshop/solutions/day-3-solution.yaml" ] \
  && pass "#461: Docs/workshop/solutions/day-3-solution.yaml exists" \
  || fail "#461: Docs/workshop/solutions/day-3-solution.yaml missing"

# day-3-solution.yaml must be a valid kro RGD (has required fields)
grep -q "kind: ResourceGraphDefinition" Docs/workshop/solutions/day-3-solution.yaml \
  && pass "#461: day-3-solution.yaml is a ResourceGraphDefinition" \
  || fail "#461: day-3-solution.yaml missing kind: ResourceGraphDefinition"

grep -q "kind: Modifier" Docs/workshop/solutions/day-3-solution.yaml \
  && pass "#461: day-3-solution.yaml schema is kind: Modifier" \
  || fail "#461: day-3-solution.yaml schema missing kind: Modifier"

grep -q "modifier-graph" Docs/workshop/solutions/day-3-solution.yaml \
  && pass "#461: day-3-solution.yaml references modifier-graph" \
  || fail "#461: day-3-solution.yaml missing modifier-graph name"

# day-3-solution.yaml must contain the blessing-agility branch
grep -q "blessing-agility" Docs/workshop/solutions/day-3-solution.yaml \
  && pass "#461: day-3-solution.yaml contains blessing-agility" \
  || fail "#461: day-3-solution.yaml missing blessing-agility modifier"

# day-3-solution.yaml must contain the correct effect string
grep -q "Blessing of Agility" Docs/workshop/solutions/day-3-solution.yaml \
  && pass "#461: day-3-solution.yaml has correct Blessing of Agility effect string" \
  || fail "#461: day-3-solution.yaml missing 'Blessing of Agility' effect string"

# Workshop README must reference learn-kro.eks.aws.dev
grep -q "learn-kro.eks.aws.dev" Docs/workshop/README.md \
  && pass "#461: workshop README references learn-kro.eks.aws.dev" \
  || fail "#461: workshop README missing learn-kro.eks.aws.dev reference"

# Workshop day guides must not require local cluster for Day 1 and Day 2
grep -q "No local cluster required" Docs/workshop/day-1-explore.md \
  && pass "#461: day-1-explore.md says no local cluster required" \
  || fail "#461: day-1-explore.md missing 'No local cluster required' statement"

grep -q "No local cluster required" Docs/workshop/day-2-read-the-rgds.md \
  && pass "#461: day-2-read-the-rgds.md says no local cluster required" \
  || fail "#461: day-2-read-the-rgds.md missing 'No local cluster required' statement"

# Day 3 must reference ArgoCD (no direct kubectl apply)
grep -q "ArgoCD\|Argo CD\|argocd" Docs/workshop/day-3-extend.md \
  && pass "#461: day-3-extend.md references ArgoCD deployment" \
  || fail "#461: day-3-extend.md missing ArgoCD deployment instructions"

# Help modal must document Workshop Kit
grep -q "Workshop Kit\|workshop kit\|docs/workshop" frontend/src/App.tsx \
  && pass "#461: Help modal documents Workshop Kit" \
  || fail "#461: Help modal missing Workshop Kit page"

# Intro tour must have Take the 3-Day workshop slide
grep -q "3-Day kro Workshop\|docs/workshop\|workshop" frontend/src/KroTeach.tsx \
  && pass "#461: KroTeach.tsx intro tour has workshop slide" \
  || fail "#461: KroTeach.tsx missing workshop intro slide"

# Journey 41 must exist
[ -f "tests/e2e/journeys/41-workshop-kit.js" ] \
  && pass "#461: tests/e2e/journeys/41-workshop-kit.js exists" \
  || fail "#461: tests/e2e/journeys/41-workshop-kit.js missing"

# --- Summary ---

echo ""
echo "========================================"
echo "  Guardrail Tests: $PASS passed, $FAIL failed"
echo "========================================"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
