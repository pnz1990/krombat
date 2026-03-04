<div align="center">
  <img src="assets/logo.png" alt="Kubernetes RPG - KROMBAT" width="400">
  
  # Kubernetes RPG
  
  *An 8-bit dungeon crawler powered by kro*
</div>

---

An interactive, turn-based dungeon game where the entire game state is orchestrated by [kro](https://kro.run) ResourceGraphDefinitions running as an [EKS Managed Capability](https://docs.aws.amazon.com/eks/latest/userguide/kro.html). No custom controllers, no external databases. Just declarative resource graphs, CEL expressions, and kro turning Kubernetes into a programmable game engine.

## Concept

Kubernetes RPG demonstrates how [kro](https://kro.run) transforms Kubernetes into a general-purpose orchestration engine. Using kro's ResourceGraphDefinitions, we model RPG game mechanics entirely as declarative resource graphs:

| Game Entity | Kubernetes Resource |
|-------------|-------------------|
| Dungeon     | Custom Resource (parent RGD, orchestrates child CRs) |
| Hero        | Custom Resource → ConfigMap (via hero-graph RGD) |
| Monster     | Custom Resource → ConfigMap (via monster-graph RGD) |
| Boss        | Custom Resource → ConfigMap (via boss-graph RGD) |
| Attack      | Custom Resource → Job (via attack-graph RGD) |
| Treasure    | Custom Resource → Secret (via treasure-graph RGD) |
| Loot        | Custom Resource → Secret (via loot-graph RGD) |
| Modifier    | Custom Resource → ConfigMap (via modifier-graph RGD) |
| Action      | Custom Resource → Job (via action-graph RGD) |

Each dungeon instance gets its own Namespace for isolation and clean teardown.

## How It Works

1. **Create a Dungeon** — specify monster count, difficulty (easy/normal/hard), and hero class (warrior/mage/rogue)
2. **kro reconciles** — creates a namespace, hero ConfigMap, monster ConfigMaps, a pending boss, a treasure Secret, and a modifier ConfigMap (curse or blessing)
3. **Attack monsters** — submit Attack CRs; kro's attack-graph RGD spawns a Job that patches the Dungeon CR's `monsterHP` array. Monsters may drop loot and inflict status effects
4. **Use items** — submit Action CRs; kro's action-graph RGD spawns a Job for equipping weapons/armor/shields, using potions, opening treasure, and unlocking doors
4. **Use abilities** — Mage heals, Warrior taunts, Rogue backstabs — all via the same Attack CR pipeline
5. **Boss unlocks** — when all monster HP=0, kro transitions the boss to `state=ready`
6. **Defeat the boss** — attack the boss to reduce `bossHP` to 0
7. **Enter Room 2** — treasure auto-opens, door auto-unlocks, click door to enter a harder room with trolls/ghouls and a bat-boss
8. **Final victory** — defeat the Room 2 boss to conquer the dungeon

The backend and frontend only interact with kro-generated CRs (Dungeon and Attack). All game logic — HP calculations, class abilities, loot drops, status effects, modifiers — lives in kro's CEL expressions and Attack Job scripts. **kro is the game engine.**

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────────┐
│  React SPA  │────▶│  Go Backend │────▶│  Kubernetes API       │
│  (8-bit UI) │◀────│  (gateway)  │◀────│  + kro controller     │
└─────────────┘  WS └─────────────┘watch└──────────────────────┘
     nginx              │                       ▲
     proxy ─────────────┘                       │ sync
                                           ┌────┴─────┐
                                           │ Argo CD  │
                                           │ (GitOps) │
                                           └────┬─────┘
                                                │
                                           ┌────┴─────┐
                                           │ Git Repo │
                                           └──────────┘
```

- **Frontend** — 8-bit D&D-inspired React SPA with pixel art styling. Nginx reverse-proxies `/api/` to the backend. All game state derived from the Dungeon CR
- **Backend** — Stateless Go service. Only touches Dungeon, Attack, and Action CRs — never reads Pods, Secrets, or Jobs. Routes item actions to Action CR, combat to Attack CR. Includes rate limiting (1 attack/s per dungeon) and Prometheus metrics on `/metrics`
- **Kubernetes + kro** — Sole source of truth. Nine RGDs orchestrate the game via CR chaining: `dungeon-graph` (parent) spawns child CRs managed by `hero-graph`, `monster-graph`, `boss-graph`, `treasure-graph`, `modifier-graph`, `loot-graph` (items as Secrets), `attack-graph` (combat), and `action-graph` (items, equipment, treasure, doors). kro runs as an [EKS Managed Capability](https://docs.aws.amazon.com/eks/latest/userguide/kro.html)
- **Argo CD** — Runs as an [EKS Managed Capability](https://docs.aws.amazon.com/eks/latest/userguide/argocd.html). Continuously syncs all cluster manifests from this Git repo. GitHub webhook for ~6s sync latency
- **Observability** — CloudWatch Container Insights for cluster/pod metrics, CloudWatch Logs for centralized log aggregation (JSON structured logs from backend, attack Job logs, kro controller logs), CloudWatch dashboard and alarms for operational monitoring

## Key Demonstrations

- **Nine-RGD orchestration** — `dungeon-graph` manages game state, `attack-graph` handles combat, `action-graph` handles items/equipment, seven child RGDs handle entities
- **RGD composition via CR chaining** — Parent RGD spawns child CRs (Hero, Monster, Boss, Treasure, Modifier), each reconciled by its own RGD into native K8s resources
- **Dynamic resource generation** — Monster count driven by CEL expressions
- **Cross-resource state derivation** — Boss readiness depends on aggregated monster HP values via CEL; Dungeon status reads Modifier CR status
- **Drift correction** — Delete a monster ConfigMap and kro recreates it with correct state from Dungeon CR
- **Optimistic concurrency** — Attack Jobs use resourceVersion preconditions for safe concurrent Dungeon CR mutation
- **CRs as the only interface** — Backend never touches native K8s objects; kro is the abstraction layer
- **Complex game logic in bash + CEL** — Hero abilities, loot drops, status effects, modifiers all computed in Attack Job scripts

## Project Structure

```
├── backend/                 # Go backend service
│   ├── cmd/                 # Entrypoint
│   ├── internal/            # Handlers, K8s client, WebSocket hub
│   └── Dockerfile           # Multi-stage build (distroless)
├── frontend/                # React SPA
│   ├── src/                 # App, Sprite, API client, WebSocket hook, CSS
│   ├── public/sprites/      # Pixel art sprite sheets (heroes, monsters, items, icons)
│   ├── nginx.conf           # Reverse proxy to backend
│   └── Dockerfile           # Node build + nginx runtime
├── manifests/               # Argo CD syncs this directory
│   ├── apps/                # Argo CD Application
│   ├── rbac/                # ServiceAccounts, Roles, Bindings
│   ├── rgds/                # 9 kro ResourceGraphDefinitions
│   └── system/              # Backend/frontend deployments, dungeon reaper
├── images/                  # Custom container images
│   └── job-runner/          # Minimal kubectl+jq+bash for Attack/Action Jobs
├── infra/                   # Terraform (EKS, capabilities, ECR, CI)
├── tests/                   # Integration test suites
│   ├── run.sh               # Game engine tests (32 tests)
│   ├── backend-api.sh       # Backend API tests (17 tests)
│   ├── guardrails.sh        # Architecture guardrails (28 tests)
│   ├── e2e/smoke-test.js    # Playwright UI tests (59 smoke tests)
│   └── e2e/journeys/       # Gameplay journey tests (88 tests across 4 journeys)
├── assets/                  # Source sprite sheets (generated via AI)
├── scripts/                 # Utility scripts
│   └── watch-dungeon.sh     # tmux dashboard for watching game state
├── docs/                    # Design documents and runbook
└── .github/workflows/       # CI pipelines
```

## Prerequisites

- Amazon EKS cluster with the [kro](https://docs.aws.amazon.com/eks/latest/userguide/kro.html) and [Argo CD](https://docs.aws.amazon.com/eks/latest/userguide/argocd.html) managed capabilities enabled
- `kubectl` configured for the target cluster
- See [infra/SETUP.md](infra/SETUP.md) for full provisioning guide

## Running the Game

The backend and frontend run in the `rpg-system` namespace, deployed via Argo CD from the `manifests/` directory.

### Access the UI

```bash
kubectl port-forward svc/rpg-frontend -n rpg-system 3000:3000
```

Open http://localhost:3000 — create a dungeon, attack monsters, defeat the boss.

### Access the Backend API directly

```bash
kubectl port-forward svc/rpg-backend -n rpg-system 8080:8080
```

```bash
# Create a dungeon
curl -X POST http://localhost:8080/api/v1/dungeons \
  -H "Content-Type: application/json" \
  -d '{"name":"my-dungeon","monsters":3,"difficulty":"normal","heroClass":"warrior"}'

# List dungeons
curl http://localhost:8080/api/v1/dungeons

# Get dungeon state
curl http://localhost:8080/api/v1/dungeons/default/my-dungeon

# Attack a monster
curl -X POST http://localhost:8080/api/v1/dungeons/default/my-dungeon/attacks \
  -H "Content-Type: application/json" \
  -d '{"target":"my-dungeon-monster-0","damage":50}'
```

### Watch game state (tmux dashboard)

```bash
./scripts/watch-dungeon.sh my-dungeon
```

### Play via kubectl only (no UI needed)

```bash
# Create a dungeon
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: my-dungeon
spec:
  monsters: 3
  difficulty: normal
  monsterHP: [50, 50, 50]
  bossHP: 400
  heroHP: 150
  heroClass: warrior
EOF

# Wait for kro (~10s), then check state
kubectl get dungeon my-dungeon -o jsonpath='{.status}'

# Attack a monster
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: attack-1
spec:
  dungeonName: my-dungeon
  dungeonNamespace: default
  target: my-dungeon-monster-0
  damage: 50
EOF

# Clean up
kubectl delete dungeon my-dungeon
```

## How to Play

### Creating a Dungeon
Choose a name, number of monsters (1-10), difficulty, and hero class. The game creates a dungeon with monsters, a boss, and your hero.

### Combat
Click a monster or boss to attack. Damage is rolled using dice (shown in the UI). After your attack, all alive enemies counter-attack automatically. Kill all monsters to unlock the boss, then defeat the boss to win.

### Difficulty Levels
| Difficulty | Monster HP | Boss HP | Monster Counter | Boss Counter | Dice |
|------------|-----------|---------|-----------------|--------------|------|
| Easy       | 30        | 200     | 1 per monster   | 3            | 1d20+2 (3-22) |
| Normal     | 50        | 400     | 2 per monster   | 5           | 2d12+4 (6-28) |
| Hard       | 80        | 800     | 3 per monster   | 8           | 3d20+5 (8-65) |

### Hero Classes
| Class | HP | Damage | Special |
|-------|-----|--------|---------|
| ⚔️ Warrior | 200 | 1.0x | 25% damage reduction on all counter-attacks |
| 🔮 Mage | 120 | 1.3x all | 8 mana (1 per attack, regen +1 per attack) |
| 🗡️ Rogue | 150 | 1.1x | 25% chance to dodge counter-attacks |

### Tips
- **Warrior**: Best for beginners. High HP lets you survive many counter-attacks
- **Mage**: Glass cannon. Rush the boss with 1.5x damage before mana runs out
- **Rogue**: High risk/reward. Dodge procs can save you, but bad luck kills you
- Kill monsters first to reduce incoming counter-attack damage before engaging the boss

### Hero Abilities
Each class has a unique active ability:

| Class | Ability | Cost | Effect |
|-------|---------|------|--------|
| ⚔️ Warrior | 🛡️ Taunt | 1 turn (no damage) | 60% damage reduction for 1 round (50% taunt + 20% passive) |
| 🔮 Mage | 💚 Heal | 2 mana | Restore 40 HP (capped at 120). Mana regens +1 per attack |
| 🗡️ Rogue | 🗡️ Backstab | 3-turn cooldown | 3x damage multiplier. Cooldown decrements each turn |

### Dungeon Modifiers
Each dungeon may spawn with a random modifier (30% curse, 30% blessing, 40% none):

| Modifier | Type | Effect |
|----------|------|--------|
| Curse of Fortitude | 🔴 Curse | Monsters +50% HP |
| Curse of Fury | 🔴 Curse | Boss counter-attack 2x damage |
| Curse of Darkness | 🔴 Curse | Hero damage -25% |
| Blessing of Strength | 🟢 Blessing | Hero damage +50% |
| Blessing of Resilience | 🟢 Blessing | Counter-attack damage halved |
| Blessing of Fortune | 🟢 Blessing | 20% chance to crit (2x damage) |

### Loot System
Monsters drop items on death. Boss always drops rare/epic loot. Each drop creates a Loot CR → Secret via the loot-graph RGD.

| Item | Effect | Common | Rare | Epic |
|------|--------|--------|------|------|
| 🗡️ Weapon | +damage for 3 attacks | +5 | +10 | +20 |
| 🛡️ Armor | +defense (reduce counter dmg) | 10% | 20% | 30% |
| 🛡️ Shield | Block chance (negate counter) | 10% | 15% | 25% |
| ❤️ HP Potion | Instant heal | 20 HP | 40 HP | Full |
| 💎 Mana Potion | Restore mana (Mage) | 2 | 3 | 5 |

Drop chance: Easy 60%, Normal 45%, Hard 35%. Click items in backpack to use/equip. Items don't cost a turn.

### Status Effects
Enemies can inflict status effects during counter-attacks:

| Effect | Source | Duration | Per-Turn |
|--------|--------|----------|----------|
| 🟢 Poison | Monsters (20%) | 3 turns | -5 HP |
| 🔴 Burn | Boss (25%) | 2 turns | -8 HP |
| 🟡 Stun | Boss (15%) | 1 turn | Skip hero attack |

## License

MIT
