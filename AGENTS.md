# Krombat — AI Agent Context

## What This Is

A turn-based dungeon RPG where the entire game state lives in Kubernetes, orchestrated by kro ResourceGraphDefinitions on Amazon EKS. Demonstrates Kubernetes as a general-purpose state machine.

---

## Architecture

- **EKS Auto Mode** cluster (`krombat`, K8s 1.34) in `us-west-2`, account `569190534191`
- **kro** (EKS Managed Capability) — nine RGDs orchestrate the game via CR chaining:
  - `dungeon-graph` (parent): Dungeon CR → Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, GameConfig CM
  - `hero-graph`: Hero CR → ConfigMap (HP, class, mana, stats via CEL)
  - `monster-graph`: Monster CR → ConfigMap (alive/dead from HP)
  - `boss-graph`: Boss CR → ConfigMap (pending/ready/defeated from HP + monstersAlive)
  - `treasure-graph`: Treasure CR → ConfigMap + Secret (opened/unopened state via CEL)
  - `modifier-graph`: Modifier CR → ConfigMap (curse/blessing effects via CEL)
  - `loot-graph`: Loot CR → Secret (item data: type, rarity, stat, description via CEL)
  - `attack-graph`: Attack CR → Job (COMBAT ONLY: monster/boss attacks, class abilities)
  - `action-graph`: Action CR → Job (NON-COMBAT: equip, use item, treasure, door, room transition)
- **Argo CD** (EKS Managed Capability) — GitOps from `manifests/`. GitHub webhook for ~6s sync
- **Go Backend** — REST API + WebSocket in `rpg-system`. ONLY touches Dungeon, Attack, and Action CRs. Routes item targets to Action CR, combat targets to Attack CR
- **React Frontend** — 8-bit pixel art with circular dungeon arena, Tibia-style equipment panel, combat modal with dice rolling. All state from Dungeon CR `spec` (not `status` — status can be stale after room transitions)

---

## Important Paths

| Path | Purpose |
|---|---|
| `manifests/rgds/` | All 9 RGD YAML files (the game engine) |
| `manifests/rbac/rbac.yaml` | ServiceAccounts, ClusterRoles, Bindings |
| `backend/internal/handlers/handlers.go` | REST handlers (routes items→Action CR, combat→Attack CR) |
| `backend/internal/k8s/watchers.go` | GVR definitions (DungeonGVR, AttackGVR, ActionGVR) |
| `frontend/src/App.tsx` | Main React app (~1000 lines) |
| `frontend/src/Sprite.tsx` | Sprite components (hurt=6→1→6, dead=6 with 0.35 opacity) |
| `tests/` | All test suites + helpers |
| `images/job-runner/` | Minimal Docker image (bash + kubectl + jq) used by Attack/Action Jobs |
| `infra/` | Terraform (EKS, kro, Argo CD, ECR, CloudWatch, OIDC) |
| `Docs/runbook.md` | Operations runbook (kubectl debug commands, CloudWatch queries) |

---

## Dungeon CR Spec Fields

`monsters`, `difficulty`, `heroClass`, `heroHP`, `heroMana`, `monsterHP` ([]int), `bossHP`, `modifier`, `tauntActive`, `backstabCooldown`, `inventory` (CSV), `weaponBonus`, `weaponUses`, `armorBonus`, `shieldBonus`, `poisonTurns`, `burnTurns`, `stunTurns`, `treasureOpened`, `currentRoom`, `doorUnlocked`, `room2MonsterHP`, `room2BossHP`, `lastHeroAction`, `lastEnemyAction`, `lastLootDrop`

---

## Game Features

- **3 Hero Classes**: Warrior (200 HP, 25% defense, Taunt), Mage (120 HP, 1.3x all, 8 mana, Heal), Rogue (150 HP, 1.1x, 25% dodge, Backstab)
- **3 Difficulty Levels**: Easy (1d20+2), Normal (2d12+4), Hard (3d20+5)
- **Multi-room dungeons**: Room 1 (goblins/skeletons + dragon) → treasure → door → Room 2 (trolls/ghouls + bat-boss)
- **Dungeon Modifiers**: 6 types (3 curses, 3 blessings) via modifier-graph RGD
- **Loot System**: Weapons, armor, shields, HP/mana potions. Only drops on kill transition (OLD_HP>0 && NEW_HP==0)
- **Status Effects**: Poison (-5/turn, 3 turns), Burn (-8/turn, 2 turns), Stun (skip attack)
- **Post-boss flow**: Auto open treasure → auto unlock door → click door to enter room 2
- **Room 2 is final**: No treasure/door after room 2 boss
- **Dungeon Reaper**: CronJob (every 10 min) deletes dungeons older than 4 hours

---

## Development Rules

- **NEVER run applications locally** — all builds via Docker/CI only
- **NEVER push directly to main as an agent** — always use a feature branch + PR (see Git Workflow below)
- **Pre-push hook runs ALL 4 test suites** — integration (32), guardrails (34), backend API (21), UI smoke (59) + journeys (88). Push blocked if any fail. Use `--no-verify` only when RGD schema changes require deploy-first
- **To deploy**: push to main → CI builds image → CI rollout restarts both backend+frontend
- **When RGD schema changes**: `kubectl delete rgd <name>` → Argo CD recreates
- **Avoid `${BASH_VAR}` in RGD YAML** — kro parses `${}` as CEL; use `$(BASH_VAR)` instead
- **Access game**: `kubectl port-forward svc/rpg-frontend -n rpg-system 3000:3000` → http://localhost:3000

---

## Git Workflow (for agents — always use branches + PRs)

```bash
# 1. Start from latest main
git checkout main && git pull origin main

# 2. Create a feature branch (use issue number)
git checkout -b issue-<number>-<short-description>
# Example: git checkout -b issue-45-fix-equip-state

# 3. Make changes, commit as needed
git add <files>
git commit -m "fix: description (#<issue-number>)"

# 4. Before pushing, rebase on latest main
git fetch origin main && git rebase origin/main

# 5. Push branch and open PR
git push origin issue-<number>-<short-description>
gh pr create --title "fix: description (#<issue-number>)" --body "Closes #<issue-number>"

# 6. Wait for CI
gh pr checks <pr-number> --watch

# 7. Merge (squash preferred)
gh pr merge <pr-number> --squash --delete-branch
```

### Branch and commit rules

- Branch naming: `issue-<number>-<short-description>` (e.g. `issue-45-fix-equip-state`)
- Commit messages: `type: description (#issue)` (e.g. `fix: equip state persistence (#45)`)
- One issue per branch — keeps PRs focused
- Include `Closes #<number>` in PR body to auto-close the issue
- After merge: `git checkout main && git pull` before starting next task

---

## Testing Workflow

**NEVER claim "done" or "try it out" without running `./scripts/ui-test.sh` first.**

### Standard workflow after frontend or backend changes

```bash
# 1. Make code changes
# 2. Commit changes
# 3. Run the deploy-and-test script:
./scripts/ui-test.sh
```

This script:
- Pushes changes to Git
- Waits for Argo CD to sync (5 min timeout)
- Waits for deployments to be ready (5 min timeout)
- Port-forwards the frontend service
- Runs curl test to verify UI responds
- Runs Playwright smoke tests (5 automated checks)
- Shows logs if anything fails

```bash
# If you already pushed and just want to re-test:
./scripts/ui-test.sh --skip-push
```

If tests fail: check output → review logs → check `test-failure.png` screenshot → fix → re-run.

### All test suites

| Suite | Command | Count | What it tests |
|---|---|---|---|
| All suites | `tests/run-all.sh` | — | Runs all 4 sequentially |
| Game engine integration | `tests/run.sh` | 32 | Core lifecycle, abilities, features, infra via `kubectl apply` |
| Architecture guardrails | `tests/guardrails.sh` | 34 | No game logic leaks, RBAC, API shape, loot guards, animation guards |
| Backend API | `tests/backend-api.sh` | 21 | REST endpoint correctness, validation, response shape, rate limiting, ability rejections |
| UI smoke | `tests/e2e/smoke-test.js` | 59 | Playwright headless browser tests |
| Journey tests | `tests/e2e/journeys/` | 88 | Full UI gameplay sessions |

### Journey test status

- [x] Journey 1: Warrior Easy — Full UI Playthrough (17/17)
- [x] Journey 2: Mage Normal — Abilities & Mana (29/29)
- [x] Journey 3: Rogue Hard — Dodge & Backstab (27/27)
- [x] Journey 4: Items & Equipment (25/25)
- [x] Journey 5: Status Effects (RNG-dependent — warns if effects not triggered by chance)
- [x] Journey 6: Dungeon Modifiers (13/13)
- [x] Journey 7: Dungeon Management (21/21)
- [x] Journey 8: Edge Cases & Error States (25/25)
 - [x] Journey 9: K8s Log Tab (23/23)
- [x] Journey 10: Visual & Animation Consistency (18/18)
- [x] Journey 11: Room 2 Full Victory — Complete both rooms end-to-end (25/25)
- [x] Journey 12: kro Teaching Layer — InsightCards, glossary, graph panel, CelTrace, K8s log annotations (25/25)

**Critical rule for journey tests**: Tests must interact exclusively through the browser UI — no `kubectl`, no direct `fetch()` to the API. Tests must exercise the real code paths where bugs live (attack-graph Jobs, kro reconciliation, frontend polling).

---

## Current Priority: FEATURE DEVELOPMENT (Issue #95 complete)

All 11 journey tests pass and are enforced by the pre-push hook. Stabilization is complete.
Next tasks may include the open feature requests:
- Issue #92: Helmet, pants, boots equipment slots with buffs
- Issue #25: Multi-phase boss mechanics with HP thresholds
- Issue #20: Loot system enhancements (persistent inventory / item effects)

---

## Key Lessons — Avoid These Regressions

- `lastLootDrop` must be cleared by ALL non-combat patches (action-graph handles this)
- `gameOver` and `bossState` must derive from `spec` fields, NOT `status` (status is stale after room transitions)
- `allMonstersDead` must be declared BEFORE `bossState` in JS (TDZ crash risk)
- Boss target matching must use `-boss$` suffix regex, not just the string "boss" (dungeon names can contain "boss")
- Attack Jobs from room 1 can run in room 2 — `enter-room-2` action must delete stale attacks
- `imagePullPolicy: IfNotPresent` on Job containers (cold start is 30–60s otherwise)
- Item actions early-return in frontend — no fallthrough to combat/loot code
- `prevInventoryRef` was removed — loot detection uses `lastLootDrop` field from server
- Avoid `${}` in RGD YAML — kro parses it as CEL; use `$()` for bash variable expansion

---

## Infrastructure

- Cluster: `krombat` in `us-west-2`, account `569190534191`
- ECR: `569190534191.dkr.ecr.us-west-2.amazonaws.com/krombat/{backend,frontend}`
- GitHub: `pnz1990/krombat`
- 9 RGDs active, Argo CD syncing from `manifests/`
- CI: `.github/workflows/build-images.yml` — builds on PR, pushes to ECR + rollout restart on main merge
