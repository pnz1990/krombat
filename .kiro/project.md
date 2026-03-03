# Kubernetes RPG — Project Context

## What This Is
A turn-based dungeon RPG where the entire game state lives in Kubernetes, orchestrated by kro ResourceGraphDefinitions on Amazon EKS. Demonstrates Kubernetes as a general-purpose state machine.

## Architecture
- **EKS Auto Mode** cluster (K8s 1.34) in us-west-2
- **kro** (EKS Managed Capability) — nine RGDs orchestrate the game via CR chaining:
  - `dungeon-graph` (parent): Dungeon CR → Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, GameConfig CM
  - `hero-graph`: Hero CR → ConfigMap (HP, class, mana, stats via CEL)
  - `monster-graph`: Monster CR → ConfigMap (alive/dead from HP)
  - `boss-graph`: Boss CR → ConfigMap (pending/ready/defeated from HP + monstersAlive)
  - `treasure-graph`: Treasure CR → ConfigMap + Secret (opened/unopened state via CEL)
  - `modifier-graph`: Modifier CR → ConfigMap (curse/blessing effects via CEL)
  - `loot-graph`: Loot CR → Secret (item data: type, rarity, stat, description via CEL)
  - `attack-graph`: Attack CR → Job (COMBAT ONLY: monster/boss attacks, abilities)
  - `action-graph`: Action CR → Job (NON-COMBAT: equip, use item, treasure, door, room transition)
- **Argo CD** (EKS Managed Capability) — GitOps from `manifests/`. GitHub webhook for ~6s sync
- **Go Backend** — REST API + WebSocket in `rpg-system`. ONLY touches Dungeon, Attack, and Action CRs. Routes item targets to Action CR, combat targets to Attack CR
- **React Frontend** — 8-bit pixel art with circular dungeon arena, Tibia-style equipment panel, combat modal with dice rolling. All state from Dungeon CR spec (not status — status can be stale after room transitions)

## Current Priority: STABILIZATION (Issue #95)

### Process
1. Write journey tests (Playwright) for each of 10 gameplay journeys
2. Run tests — failures reveal real bugs
3. Open GH issues for each bug found
4. Fix bugs one at a time, merge, verify journey passes
5. Move to next journey
6. Once all journeys pass: add to pre-push hook, close bug issues
7. NO NEW FEATURES until all journeys pass consistently

### Journey Status (track progress here)
- [ ] Journey 1: Warrior Easy — Full Room 1+2 Victory
- [ ] Journey 2: Mage Normal — Abilities & Mana
- [ ] Journey 3: Rogue Hard — Dodge & Backstab
- [ ] Journey 4: Items & Equipment
- [ ] Journey 5: Status Effects
- [ ] Journey 6: Dungeon Modifiers
- [ ] Journey 7: Dungeon Management (delete, list, navigate)
- [ ] Journey 8: Edge Cases & Error States
- [ ] Journey 9: K8s Log Tab
- [ ] Journey 10: Visual & Animation Consistency

### Known Bugs (open GH issues as found)
- Delete dungeon not working from UI
- Room 2 boss shows defeated then comes back alive
- Room 2 monsters sometimes skipped
- Combat result sometimes empty (first attack or stale lastHeroAction)
- Dungeon names containing "boss" break target matching (FIXED: grep -q "\-boss$")

### Key Lessons (avoid regressions)
- `lastLootDrop` must be cleared by ALL non-combat patches (action-graph handles this now)
- `gameOver` and `bossState` must derive from spec fields, NOT status (status is stale after room transitions)
- `allMonstersDead` must be declared BEFORE `bossState` (TDZ crash)
- Boss target matching must use `-boss$` suffix, not just `boss` anywhere (dungeon names can contain "boss")
- Attack Jobs from room 1 can run in room 2 — enter-room-2 must delete stale attacks
- `imagePullPolicy: IfNotPresent` on Job containers (cold start is 30-60s otherwise)
- Item actions early-return in frontend (no fallthrough to combat/loot code)
- `prevInventoryRef` was removed — loot detection uses `lastLootDrop` field from server

## Game Features
- **3 Hero Classes**: Warrior (200 HP, 25% defense, Taunt), Mage (120 HP, 1.3x all, 8 mana, Heal), Rogue (150 HP, 1.1x, 25% dodge, Backstab)
- **Multi-room dungeons**: Room 1 (goblins/skeletons + dragon) → treasure → door → Room 2 (trolls/ghouls + bat-boss)
- **Dungeon Modifiers**: 6 types (3 curses, 3 blessings) via modifier-graph RGD
- **Loot System**: Weapons, armor, shields, HP/mana potions. Only drops on kill transition (OLD_HP>0 && NEW_HP==0)
- **Status Effects**: Poison (-5/turn), Burn (-8/turn), Stun (skip attack)
- **D&D Dice**: Easy 1d20+2, Normal 2d12+4, Hard 3d20+5
- **Post-boss flow**: Auto open treasure → auto unlock door → click door to enter room 2
- **Room 2 is final**: No treasure/door after room 2 boss

## Dungeon CR Spec Fields
`monsters`, `difficulty`, `heroClass`, `heroHP`, `heroMana`, `monsterHP: []int`, `bossHP`, `modifier`, `tauntActive`, `backstabCooldown`, `inventory` (CSV), `weaponBonus`, `weaponUses`, `armorBonus`, `shieldBonus`, `poisonTurns`, `burnTurns`, `stunTurns`, `treasureOpened`, `currentRoom`, `doorUnlocked`, `room2MonsterHP`, `room2BossHP`, `lastHeroAction`, `lastEnemyAction`, `lastLootDrop`

## Development Rules
- **NEVER run applications locally** — all builds via Docker/CI
- **Pre-push hook runs ALL 4 test suites** — integration (32), guardrails (28), backend API (17), UI smoke (59). Push blocked if any fail. Use `--no-verify` only when RGD schema changes require deploy-first
- **Push directly to main** — Argo CD tracks main
- **To deploy**: push to main → CI builds image → CI rollout restarts both backend+frontend
- **When RGD schema changes**: `kubectl delete rgd <name>` → Argo CD recreates
- **Avoid `${BASH_VAR}` in RGD YAML** — kro parses `${}` as CEL
- **Access game**: `kubectl port-forward svc/rpg-frontend -n rpg-system 3000:3000` → http://localhost:3000

## Testing
- `tests/run-all.sh` — Runs all 4 suites sequentially
- `tests/run.sh` — 32 parallel game engine tests (4 groups: core, abilities, features, infra)
- `tests/guardrails.sh` — 28 guardrail tests (no game logic leaks, RBAC, API shape, loot guards, animation guards, combat/action separation)
- `tests/backend-api.sh` — 17 backend API tests (supports API_URL env var)
- `tests/e2e/smoke-test.js` — 59 Playwright UI tests
- `tests/e2e/journeys/` — (TODO) 10 comprehensive gameplay journey tests
- `.githooks/pre-push` — runs all 4 suites before every push

## Important Paths
- `manifests/rgds/` — All 9 RGD YAML files
- `manifests/rbac/rbac.yaml` — ServiceAccounts, ClusterRoles, Bindings
- `backend/internal/handlers/handlers.go` — REST handlers (routes items→Action CR, combat→Attack CR)
- `backend/internal/k8s/watchers.go` — GVR definitions (DungeonGVR, AttackGVR, ActionGVR)
- `frontend/src/App.tsx` — Main React app (~1000 lines)
- `frontend/src/Sprite.tsx` — Sprite components (hurt=6→1→6, dead=6 with 0.35 opacity)
- `tests/` — All test suites + helpers

## Cluster Details
- Cluster: `krombat` in us-west-2, account 569190534191
- ECR: `569190534191.dkr.ecr.us-west-2.amazonaws.com/krombat/{backend,frontend}`
- GitHub: `pnz1990/krombat`
- 9 RGDs Active, Argo CD syncing from manifests/
