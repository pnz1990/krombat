# Kubernetes RPG — Project Context

## What This Is
A turn-based dungeon RPG where the entire game state lives in Kubernetes, orchestrated by kro ResourceGraphDefinitions on Amazon EKS. Demonstrates Kubernetes as a general-purpose state machine.

## Architecture
- **EKS Auto Mode** cluster (K8s 1.34) in us-west-2
- **kro** (EKS Managed Capability) — eight RGDs orchestrate the game via CR chaining:
  - `dungeon-graph` (parent): Dungeon CR → Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, GameConfig CM, ResourceQuota, NetworkPolicy
  - `hero-graph`: Hero CR → ConfigMap (HP, class, mana, stats via CEL)
  - `monster-graph`: Monster CR → Pod (alive/dead labels from HP)
  - `boss-graph`: Boss CR → Pod (pending/ready/defeated from HP + monstersAlive)
  - `treasure-graph`: Treasure CR → ConfigMap + Secret (opened/unopened state via CEL)
  - `modifier-graph`: Modifier CR → ConfigMap (curse/blessing effects via CEL)
  - `loot-graph`: Loot CR → Secret (item data: type, rarity, stat, description via CEL)
  - `attack-graph`: Attack CR → Job (combat, abilities, items, effects, loot drops)
- **Argo CD** (EKS Managed Capability) — GitOps from `manifests/`. GitHub webhook for ~6s sync
- **Go Backend** — REST API + WebSocket in `rpg-system`. ONLY touches Dungeon and Attack CRs. Rate limiting, Prometheus metrics (game state gauges)
- **React Frontend** — 8-bit pixel art with circular dungeon arena, Tibia-style equipment panel, combat modal with dice rolling, PixelIcon SVG icons. All state from Dungeon CR

## Game Features
- **3 Hero Classes**: Warrior (200 HP, 25% defense, Taunt), Mage (120 HP, 1.3x all, 8 mana, Heal), Rogue (150 HP, 1.1x, 25% dodge, Backstab)
- **Dungeon Modifiers**: 6 types (3 curses, 3 blessings) via modifier-graph RGD
- **Loot System**: Weapons, armor, shields, HP/mana potions. Each drop creates a Loot CR → Secret via loot-graph RGD
- **Status Effects**: Poison (-5/turn), Burn (-8/turn), Stun (skip attack)
- **Equipment Panel**: Tibia-style body slots (helmet, shield, armor, weapon, pants, boots) + backpack grid
- **Combat Modal**: Full-screen dice rolling → detailed breakdown of all modifiers/effects
- **Dungeon Arena**: Circular battlefield with positioned sprites, dungeon props, flying bats, stone floor
- **D&D Dice**: Easy 1d20+2, Normal 2d12+4, Hard 3d20+5
- **Treasure**: Opened via Attack CR pipeline, state tracked in RGD (locked/unopened/opened)
- **K8s Log**: Shows kubectl commands and YAML for every action (clickable to view full YAML)

## Dungeon CR Spec Fields
- `monsters`, `difficulty`, `heroClass`, `heroHP`, `heroMana`
- `monsterHP: []int`, `bossHP: int`
- `modifier` (none/curse-*/blessing-*)
- `tauntActive`, `backstabCooldown`
- `inventory` (CSV string), `weaponBonus`, `weaponUses`, `armorBonus`, `shieldBonus`
- `poisonTurns`, `burnTurns`, `stunTurns`
- `treasureOpened`
- `lastHeroAction`, `lastEnemyAction`

## Dungeon CR Status Fields (all derived via CEL)
- `livingMonsters`, `bossState`, `victory`, `defeat`, `loot`, `treasureState`
- `modifier`, `modifierType`
- `maxMonsterHP`, `maxBossHP`, `maxHeroHP` (from gameConfig + Hero CR)
- `diceFormula`, `monsterCounter`, `bossCounter` (from gameConfig)

## Key Design Decisions
- **CRs as the only interface** — backend/frontend ONLY touch Dungeon and Attack CRs
- **Attack Jobs are the game engine** — all combat, abilities, loot, effects in bash
- **Frontend is a pure view** — reads ALL values from CR spec/status, zero game logic
- **Backend sets initial values only** — HP, class, modifier at creation. No combat logic
- **kro CEL for state derivation** — status fields, labels, descriptions. No randomness (CEL limitation)

## Development Rules
- **NEVER run applications locally** — all builds via Docker/CI
- **Pre-push hook runs all tests locally** — integration, guardrails, backend API. Push blocked if any fail
- **Push directly to main** — Argo CD tracks main. Feature branches don't work (RGDs must deploy to test)
- **To deploy**: push to main → CI builds image → Argo CD syncs → CI rollout restarts pods
- **When RGD schema changes**: `kubectl delete rgd <name>` → Argo CD recreates
- **Avoid `${BASH_VAR}` in attack-graph YAML** — kro parses `${}` as CEL
- **Avoid `[ ] &&` in attack-graph** — `set -e` kills script on false condition

## Testing
- `tests/run.sh` — 30 parallel game engine tests (4 groups: core, abilities, features, infra)
- `tests/backend-api.sh` — 17 backend API tests
- `tests/guardrails.sh` — 18 guardrail tests (no game logic leaks, RBAC, API shape)
- `tests/e2e/smoke-test.js` — ~50 Playwright UI tests
- `.githooks/pre-push` — runs all tests before every push

## Important Paths
- `manifests/rgds/` — All 8 RGD YAML files
- `manifests/rbac/rbac.yaml` — ServiceAccounts, ClusterRoles, Bindings
- `backend/internal/handlers/` — REST handlers, metrics, rate limiter
- `frontend/src/App.tsx` — Main React app (dungeon arena, combat modal, equip panel)
- `frontend/src/Sprite.tsx` — Sprite + ItemSprite components
- `frontend/src/PixelIcon.tsx` — SVG pixel art icons
- `frontend/public/sprites/` — Individual frame images per entity + items/icons/dungeon props
- `tests/` — All test suites + helpers

## Cluster Details
- Cluster: `krombat` in us-west-2, account 569190534191
- ECR: `569190534191.dkr.ecr.us-west-2.amazonaws.com/krombat/{backend,frontend}`
- GitHub: `pnz1990/krombat`
