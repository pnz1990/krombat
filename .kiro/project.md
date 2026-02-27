# Kubernetes RPG — Project Context

## Git Workflow
**Multiple AI agents work in parallel. See `.kiro/agent-workflow.md` for the full workflow.**
- Never commit directly to main — use feature branches + PRs
- Branch naming: `issue-<number>-<short-description>`
- Rebase on main before pushing
- CI validates builds and runs tests on PRs

## What This Is
A turn-based dungeon RPG where the entire game state lives in Kubernetes, orchestrated by kro ResourceGraphDefinitions on Amazon EKS. Demonstrates Kubernetes as a general-purpose state machine.

## Architecture
- **EKS Auto Mode** cluster (K8s 1.34) in us-west-2
- **kro** (EKS Managed Capability) — seven RGDs orchestrate the game via CR chaining:
  - `dungeon-graph` (parent): Dungeon CR → Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, ResourceQuota, NetworkPolicy
  - `hero-graph`: Hero CR → ConfigMap (state carrier with HP/class/mana)
  - `monster-graph`: Monster CR → Pod (alive/dead labels derived from HP)
  - `boss-graph`: Boss CR → Pod (pending/ready/defeated from HP + monstersAlive)
  - `treasure-graph`: Treasure CR → Secret (loot)
  - `modifier-graph`: Modifier CR → ConfigMap (curse/blessing effects via CEL)
  - `attack-graph`: Attack CR → Job that patches Dungeon CR (combat, abilities, items, effects)
- **Argo CD** (EKS Managed Capability) — GitOps deployment from `manifests/` directory. GitHub webhook for ~6s sync
- **Go Backend** — REST API + WebSocket gateway in `rpg-system` namespace. ONLY interacts with Dungeon and Attack CRs (game.k8s.example). Never reads Pods, Secrets, Jobs, or any native K8s objects. Rate limiting (300ms/dungeon), Prometheus metrics on `/metrics`. Image in ECR
- **React Frontend** — 8-bit D&D-inspired SPA with pixel art sprites (Press Start 2P font). Nginx reverse-proxies `/api/` to backend. Derives all state from Dungeon CR. Image in ECR

## Game Features
- **3 Hero Classes**: Warrior (150 HP, 20% defense, Taunt ability), Mage (80 HP, 1.5x boss dmg, Heal ability, mana), Rogue (100 HP, 1.2x dmg, 30% dodge, Backstab ability)
- **Dungeon Modifiers**: 6 types (3 curses, 3 blessings) randomly assigned, tracked via modifier-graph RGD
- **Loot System**: Monsters drop weapons/armor/potions on kill, usable via Attack CR pipeline
- **Status Effects**: Poison (monsters, -5 HP/turn), Burn (boss, -8 HP/turn), Stun (boss, skip attack)
- **Sprite Animations**: Hero/monster/boss sprites with idle/attack/hurt/dead frames
- **Floating Damage Numbers**: Visual feedback during combat

## Game Flow
1. Create Dungeon CR with `monsters`, `difficulty`, `heroClass`, `modifier`
2. kro (dungeon-graph) creates namespace + child CRs (Hero, Monster×N, Boss, Treasure, Modifier)
3. Child RGDs reconcile CRs into native resources (Pods, ConfigMaps, Secrets)
4. Create Attack CR → kro (attack-graph) spawns Job → Job patches Dungeon CR
5. Attack Job handles: combat damage, class abilities (heal/taunt/backstab), item use/equip, status effects, loot drops
6. kro cascades: Dungeon CR → child CRs updated → child RGDs update Pods → Dungeon status updated
7. Victory when bossHP=0, Defeat when heroHP=0

## Key Design Decisions
- **CRs as the only interface** — backend and frontend ONLY touch Dungeon and Attack CRs
- **HP state lives on Dungeon CR spec** — kro owns pods and would revert external mutations
- **Attack Jobs are the game engine** — all combat math, abilities, loot, effects in bash scripts
- **Backend is dumb** — only creates Dungeon/Attack CRs, validates input, no game logic
- **Frontend is a pure view** — reads ALL game values from Dungeon CR spec/status, zero hardcoded game values
- **No ingress/LB** — access via `kubectl port-forward` only

## Dungeon CR Spec Fields
- `monsters`, `difficulty`, `heroClass`, `heroHP`, `heroMana`
- `monsterHP: []int`, `bossHP: int`
- `modifier` (none/curse-*/blessing-*)
- `tauntActive`, `backstabCooldown`
- `inventory` (CSV string), `weaponBonus`, `weaponUses`, `armorBonus`
- `poisonTurns`, `burnTurns`, `stunTurns`
- `lastHeroAction`, `lastEnemyAction`

## Dungeon CR Status Fields (all derived via CEL, never set by backend/frontend)
- `livingMonsters`, `bossState`, `victory`, `defeat`, `loot`
- `modifier`, `modifierType`
- `maxMonsterHP`, `maxBossHP`, `maxHeroHP` (from gameConfig ConfigMap + Hero CR)
- `diceFormula`, `monsterCounter`, `bossCounter` (from gameConfig ConfigMap)

## Development Rules
- **NEVER run applications locally** — all builds via Docker, pushed to ECR through GitHub Actions CI
- **Deployments happen via Argo CD** — push manifests to Git, Argo CD syncs to cluster
- **Feature branches + PRs** — all changes go through feature branches (`feature/issue-XX-desc`), PRs to `main`, CI must pass before merge. No direct pushes to `main`
- **To deploy**: merge PR → CI builds image → `kubectl rollout restart deployment/<name> -n rpg-system`
- **When RGD schema changes**: `kubectl delete rgd <name>` → Argo CD recreates
- **Local validation only**: `go build` for compilation, `python3 -c "import yaml; ..."` for YAML
- **Avoid `${BASH_VAR}` in attack-graph YAML** — kro parses `${}` as CEL. Use `$VAR` or `"$VAR""text"`

## Testing
- `tests/run.sh` — ~47 game engine tests (lifecycle, abilities, modifiers, effects, loot, drift, RGD health)
- `tests/backend-api.sh` — 15 backend API tests (CRUD, validation, rate limiting, metrics)
- `tests/guardrails.sh` — 17 guardrail tests (no Clientset, RBAC locked, API shape, no game logic in frontend)
- `tests/e2e/smoke-test.js` — ~40 Playwright UI tests (all classes, abilities, items, modals, routing)
- CI runs game engine + guardrails + backend API on every push

## Important Paths
- `manifests/rgds/` — All 7 RGD YAML files
- `manifests/rbac/rbac.yaml` — ServiceAccounts, ClusterRoles, Bindings
- `manifests/system/` — Backend/frontend deployments
- `backend/internal/handlers/handlers.go` — All REST handlers
- `frontend/src/App.tsx` — Main React app
- `frontend/src/Sprite.tsx` — Sprite animation component
- `frontend/src/api.ts` — API client types
- `tests/` — All test suites
- `docs/runbook.md` — Operations runbook

## Cluster Details
- Cluster: `krombat` in us-west-2, account 569190534191
- ECR: `569190534191.dkr.ecr.us-west-2.amazonaws.com/krombat/{backend,frontend}`
- GitHub: `pnz1990/krombat`
