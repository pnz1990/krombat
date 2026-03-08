#!/usr/bin/env bash
# Guardrail: Ensure backend ONLY interacts with kro-generated CRs
# This test prevents regression — the backend must never touch native K8s objects
set -euo pipefail

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
NON_GAME_GVR=$(grep -rn "GroupVersionResource{" "$BACKEND_DIR/internal/" 2>/dev/null | grep -v "game.k8s.example" || true)
[ -z "$NON_GAME_GVR" ] \
  && pass "All GVR definitions are game.k8s.example" \
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

# --- Live cluster guardrails ---

echo ""
echo "--- Live cluster checks ---"

# Verify the SA can access dungeons
RESULT=$(kubectl auth can-i get dungeons.game.k8s.example --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "yes" ] \
  && pass "rpg-backend-sa can get dungeons" \
  || fail "rpg-backend-sa cannot get dungeons"

# Verify the SA CANNOT access pods
RESULT=$(kubectl auth can-i get pods --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get pods" \
  || fail "rpg-backend-sa can get pods (should not)"

# Verify the SA CANNOT access secrets
RESULT=$(kubectl auth can-i get secrets --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get secrets" \
  || fail "rpg-backend-sa can get secrets (should not)"

# Verify the SA CANNOT access jobs
RESULT=$(kubectl auth can-i get jobs --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>&1 || true)
[ "$RESULT" = "no" ] \
  && pass "rpg-backend-sa CANNOT get jobs" \
  || fail "rpg-backend-sa can get jobs (should not)"

# Verify the SA CANNOT create namespaces
RESULT=$(kubectl auth can-i create namespaces --as=system:serviceaccount:rpg-system:rpg-backend-sa 2>/dev/null || true)
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
  kubectl port-forward svc/rpg-backend -n rpg-system ${GUARDRAIL_PORT}:8080 &
  PF_PID=$!
  sleep 3
fi

# Create a test dungeon
TEST_NAME="guardrail-$(date +%s)"
curl -s -X POST http://localhost:$GUARDRAIL_PORT/api/v1/dungeons \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TEST_NAME\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null

sleep 10

# GetDungeon response must be a raw CR (not wrapped)
RESP=$(curl -s http://localhost:$GUARDRAIL_PORT/api/v1/dungeons/default/$TEST_NAME)
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
kubectl delete dungeon "$TEST_NAME"  --ignore-not-found --wait=false &>/dev/null
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

# Guard: Go handler has a no-drop path (computeMonsterLoot can return false — majority of kills)
NO_DROP_PATH=$(grep -c 'dropped.*false\|!dropped\|if dropped' backend/internal/handlers/handlers.go 2>/dev/null || echo 0)
[ "$NO_DROP_PATH" -ge 1 ] && pass "Go handler has no-drop path (loot not always awarded on kill)" || fail "Go handler missing no-drop path"

# Live cluster guard: Loot Secret must NOT exist while monster is alive, MUST exist after kill
echo "=== Loot Secret live guard"
LOOT_TEST="loot-guard-$(date +%s)"
PF_LOOT_PID=""
LOOT_PORT=8085
if ! curl -s http://localhost:$LOOT_PORT/healthz &>/dev/null; then
  kubectl port-forward svc/rpg-backend -n rpg-system ${LOOT_PORT}:8080 &
  PF_LOOT_PID=$!
  sleep 3
fi

# Create a 1-monster easy dungeon so we can kill it in one shot (easy=30 HP, warrior hits ~12-22)
curl -s -X POST http://localhost:$LOOT_PORT/api/v1/dungeons \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$LOOT_TEST\",\"monsters\":1,\"difficulty\":\"easy\",\"heroClass\":\"warrior\"}" -o /dev/null
sleep 10  # wait for kro to reconcile

# Verify no Loot Secret exists while monster-0 is alive (hp > 0)
LOOT_SECRET_BEFORE=$(kubectl get secret "${LOOT_TEST}-monster-0-loot" -n default --ignore-not-found 2>/dev/null || true)
[ -z "$LOOT_SECRET_BEFORE" ] && pass "No Loot Secret while monster is alive (hp > 0)" || fail "Loot Secret exists before monster killed"

# Kill monster-0 with lethal damage (easy monster has 30 HP; send 100 damage to guarantee kill)
curl -s -X POST http://localhost:$LOOT_PORT/api/v1/dungeons/default/$LOOT_TEST/attacks \
  -H "Content-Type: application/json" \
  -d "{\"target\":\"${LOOT_TEST}-monster-0\",\"damage\":100}" -o /dev/null
sleep 8  # wait for kro to reconcile Loot CR and Secret

# Verify Loot Secret exists now that monster-0 is dead (hp == 0)
LOOT_SECRET_AFTER=$(kubectl get secret "${LOOT_TEST}-monster-0-loot" -n default --ignore-not-found 2>/dev/null || true)
[ -n "$LOOT_SECRET_AFTER" ] && pass "Loot Secret exists after monster killed (hp == 0)" || fail "Loot Secret missing after monster killed"

# Verify lastLootDrop field is present in dungeon spec (may be empty if no drop — that is valid)
LOOT_DROP_FIELD=$(kubectl get dungeon "$LOOT_TEST" -n default -o jsonpath='{.spec.lastLootDrop}' 2>/dev/null || echo "__missing__")
[ "$LOOT_DROP_FIELD" != "__missing__" ] && pass "lastLootDrop field present in dungeon spec after kill" || fail "lastLootDrop field missing from dungeon spec"

# Cleanup loot test dungeon
kubectl delete dungeon "$LOOT_TEST" --ignore-not-found --wait=false &>/dev/null
[ -n "$PF_LOOT_PID" ] && kill "$PF_LOOT_PID" 2>/dev/null

# --- loot-graph includeWhen drop guard (direct Monster CR) ---
# Guard: loot-graph Secret must NOT be created for a living monster (hp > 0),
# and MUST be created once hp is patched to 0. Tests the kro includeWhen gate directly,
# bypassing the backend API, to verify the RGD-level invariant.
echo "=== loot-graph includeWhen drop guard (direct Monster CR)"
DROP_GUARD_NAME="loot-drop-guard-$(date +%s)"
DROP_GUARD_NS="default"

# Apply a Monster CR with hp=10 (alive) directly — no dungeon needed for this RGD test
kubectl apply -f - &>/dev/null <<EOF
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
LOOT_CR_ALIVE=$(kubectl get loot "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -z "$LOOT_CR_ALIVE" ] \
  && pass "loot-graph: no Loot CR created for living monster (hp > 0)" \
  || fail "loot-graph: Loot CR created for living monster (hp > 0) — includeWhen guard broken"

# Assert: no loot Secret while monster is alive
LOOT_SEC_ALIVE=$(kubectl get secret "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -z "$LOOT_SEC_ALIVE" ] \
  && pass "loot-graph: no loot Secret created for living monster (hp > 0)" \
  || fail "loot-graph: loot Secret created for living monster (hp > 0) — includeWhen guard broken"

# Patch hp to 0 (kill transition) directly on the Monster CR
kubectl patch monster "${DROP_GUARD_NAME}" -n "$DROP_GUARD_NS" \
  --type=merge -p '{"spec":{"hp":0}}' &>/dev/null

sleep 8  # wait for kro to reconcile loot-graph

# Assert: Loot CR now exists (hp == 0 satisfies includeWhen)
LOOT_CR_DEAD=$(kubectl get loot "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -n "$LOOT_CR_DEAD" ] \
  && pass "loot-graph: Loot CR created after monster killed (hp == 0)" \
  || fail "loot-graph: Loot CR missing after monster killed (hp == 0) — includeWhen not firing"

# Assert: loot Secret now exists (loot-graph reconciled from the Loot CR)
LOOT_SEC_DEAD=$(kubectl get secret "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found 2>/dev/null || true)
[ -n "$LOOT_SEC_DEAD" ] \
  && pass "loot-graph: loot Secret created after monster killed (hp == 0)" \
  || fail "loot-graph: loot Secret missing after monster killed (hp == 0) — loot-graph not reconciling"

# Cleanup
kubectl delete monster "${DROP_GUARD_NAME}" -n "$DROP_GUARD_NS" --ignore-not-found --wait=false &>/dev/null
kubectl delete loot "${DROP_GUARD_NAME}-monster-0-loot" -n "$DROP_GUARD_NS" --ignore-not-found --wait=false &>/dev/null

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

# --- Summary ---

echo ""
echo "========================================"
echo "  Guardrail Tests: $PASS passed, $FAIL failed"
echo "========================================"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
