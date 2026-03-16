# Krombat — AI Agent Context

## CRITICAL: kubectl Context Rule

**ALWAYS pass `--context arn:aws:eks:us-west-2:319279230668:cluster/krombat` on EVERY kubectl command.** Multiple EKS clusters share this kubeconfig. Never rely on `kubectl config use-context` — another session may switch it. This applies to direct kubectl calls AND to test scripts (set `KUBECTL_CONTEXT` env var or pass `--context` inline).

Example: `kubectl --context arn:aws:eks:us-west-2:319279230668:cluster/krombat get pods -n rpg-system`

## What This Is

A turn-based dungeon RPG where game state lives in Kubernetes Custom Resources on Amazon EKS, with kro ResourceGraphDefinitions orchestrating the resource graph. Demonstrates Kubernetes as a general-purpose state machine.

---

## Architecture

- **EKS Auto Mode** cluster (`krombat`, K8s 1.34) in `us-west-2`, account `319279230668`
- **kro** (self-installed via Helm, patched fork `cel-writeback-d`) — nine RGDs manage the resource graph and derived status:
  - `dungeon-graph` (parent): Dungeon CR → Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, GameConfig CM, combatResult CM, actionResult CM
  - `hero-graph`: Hero CR → ConfigMap (HP, class, mana, stats via CEL)
  - `monster-graph`: Monster CR → ConfigMap (alive/dead from HP)
  - `boss-graph`: Boss CR → ConfigMap (pending/ready/defeated from HP + monstersAlive; boss phase + damage multiplier via CEL)
  - `treasure-graph`: Treasure CR → ConfigMap + Secret (opened/unopened state via CEL)
  - `modifier-graph`: Modifier CR → ConfigMap (curse/blessing effects via CEL)
  - `loot-graph`: Loot CR → Secret (item data: type, rarity, stat, description via CEL)
  - `attack-graph`: defines the Attack CRD (no resources — CRD only)
  - `action-graph`: defines the Action CRD (no resources — CRD only)
- **Argo CD** (EKS Managed Capability) — GitOps from `manifests/`. GitHub webhook for ~6s sync
- **Go Backend** — REST API + WebSocket in `rpg-system`. Creates/patches Dungeon CRs, creates Attack and Action CRs to trigger state changes. **The Go backend IS the game engine**: all combat math, damage, HP mutations, item effects, status effects, loot drops, and room transitions are computed in Go (`handlers.go`). The `combatResult` and `actionResult` ConfigMaps in dungeon-graph contain pre-computed CEL values (equip bonuses, HP-after-potion, Room 2 HP, etc.) but the backend currently re-derives all of these independently — those CEL blocks are scaffolding for a future migration, not active logic.
- **React Frontend** — 8-bit pixel art with circular dungeon arena, Tibia-style equipment panel, combat modal with dice rolling. All state from Dungeon CR `spec` (not `status` — status can be stale after room transitions)

### What kro actually computes (active, not dead code)

| RGD | What kro CEL computes that matters |
|---|---|
| `dungeon-graph` | Namespace, all child CRs, GameConfig CM (dice formula, HP/counter tables), Dungeon status fields |
| `boss-graph` | `entityState` (pending/ready/defeated), `bossPhase` (phase1/2/3), `damageMultiplier` (1.0/1.3/1.6) |
| `hero-graph` | `maxHP`, `maxMana`, `classNote` in status |
| `monster-graph` | `entityState` (alive/dead) per monster |
| `modifier-graph` | `effect` description string, `multiplier` |
| `treasure-graph` | `state` (opened/unopened), loot key string |
| `loot-graph` | Item `type`, `rarity`, `stat`, `description` |

### What the Go backend computes (the actual game engine)

- All combat math: dice rolls (seeded by Attack CR UID), hero damage (class multipliers, backstab, weapon, helmet, amulet), boss counter-attack chain (armor, shield, warrior/rogue/pants defense, taunt reduction, one-shot floor), monster counter-attack + archer stun + shaman heal abilities
- Status effects: DoT application (poison −5/turn, burn −8/turn, stun), infliction chances per boss/monster type, boots resist rolls
- Mana lifecycle: consumption per attack, heal cost, regen on kill, mana restore on room entry
- Loot drops: kill-transition detection, drop chance by difficulty, rarity roll, item type selection (seeded by dungeon name + index)
- Item effects: all 27 equip cases (9 types × 3 rarities), potion healing (class-clamped), inventory add/remove/cap
- Room transitions: Room 2 HP scaling (monsters ×1.5, boss ×1.3), modifier adjustments, monster type reassignment, state resets
- Leaderboard: outcome derivation, turn counting, ConfigMap storage (`krombat-leaderboard` in `rpg-system` — plain ConfigMap, no kro interface)

### What the frontend computes (display + necessary spec re-derivation)

- `gameOver`, `isVictory`, `bossState`, `allMonstersDead` — re-derived from `spec` fields (intentional: `status` is stale after room transitions)
- `bossPhase` fallback — re-derives from `spec.bossHP / maxBossHP` when `status.bossPhase` is `phase1` (matches boss-graph thresholds: 50% / 25%)
- Achievement badges — 8 conditions derived client-side only, not persisted to K8s
- `maxHeroHP` — read from `status.maxHeroHP` (from hero-graph); fallback is wrong (uses current HP, not class default)

---

## Important Paths

| Path | Purpose |
|---|---|
| `manifests/rgds/` | All 9 RGD YAML files (kro resource graph) |
| `manifests/rbac/rbac.yaml` | ServiceAccounts, ClusterRoles, Bindings |
| `backend/internal/handlers/handlers.go` | **The game engine**: combat math, item effects, loot, room transitions, leaderboard |
| `backend/internal/k8s/watchers.go` | GVR definitions (DungeonGVR, AttackGVR, ActionGVR) |
| `frontend/src/App.tsx` | Main React app (~1000 lines) |
| `frontend/src/Sprite.tsx` | Sprite components (hurt=6→1→6, dead=6 with 0.35 opacity) |
| `tests/` | All test suites + helpers |
| `infra/` | Terraform (EKS, kro, Argo CD, ECR, CloudWatch, OIDC) |
| `Docs/runbook.md` | Operations runbook (kubectl debug commands, CloudWatch queries) |

---

## Dungeon CR Spec Fields

`monsters`, `difficulty`, `heroClass`, `heroHP`, `heroMana`, `monsterHP` ([]int), `bossHP`, `modifier`, `tauntActive`, `backstabCooldown`, `inventory` (CSV), `weaponBonus`, `weaponUses`, `armorBonus`, `shieldBonus`, `helmetBonus`, `pantsBonus`, `bootsBonus`, `ringBonus`, `amuletBonus`, `poisonTurns`, `burnTurns`, `stunTurns`, `treasureOpened`, `currentRoom`, `doorUnlocked`, `room2MonsterHP`, `room2BossHP`, `lastHeroAction`, `lastEnemyAction`, `lastLootDrop`

---

## Game Features

- **3 Hero Classes**: Warrior (200 HP, 25% defense, Taunt), Mage (120 HP, 1.3x all, 8 mana, Heal), Rogue (150 HP, 1.1x, 25% dodge, Backstab)
- **3 Difficulty Levels**: Easy (1d20+3), Normal (2d12+6), Hard (3d20+8)
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
- **Access game**: `https://learn-kro.eks.aws.dev` (internet-facing ALB — **NEVER use port-forward**)

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

**NEVER claim "done" or "try it out" without running journey tests against prod first.**

### Standard workflow after frontend or backend changes

```bash
# 1. Make code changes
# 2. Commit and push via PR (see Git Workflow)
# 3. Wait for CI deploy to land on prod (Argo CD syncs in ~6s after merge to main)
# 4. Clean up any stale dungeons before testing:
kubectl --context arn:aws:eks:us-west-2:319279230668:cluster/krombat delete dungeons --all -A
# 5. Run journey tests in batches of 8 against prod (NEVER port-forward):
BASE_URL=https://learn-kro.eks.aws.dev node tests/e2e/run-journeys.js 01,02,03,04,05,06,07,08
BASE_URL=https://learn-kro.eks.aws.dev node tests/e2e/run-journeys.js 09,10,11,12,13,14,15,16
BASE_URL=https://learn-kro.eks.aws.dev node tests/e2e/run-journeys.js 17,18,19,20,21,22,23,24
BASE_URL=https://learn-kro.eks.aws.dev node tests/e2e/run-journeys.js 25,26,27,28,29,30,31,32
```

**Port-forward is BANNED for testing.** It drops mid-test and causes false failures. Always use `BASE_URL=https://learn-kro.eks.aws.dev` directly.

**Always clean dungeons before a test run.** Stale dungeons from prior runs pollute state and cause flaky failures.

**Run journeys in batches of 8 max.** Running all 32 in parallel overwhelms the cluster and causes timeouts.

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

**Critical rule for journey tests**: Tests must interact exclusively through the browser UI — no `kubectl`, no direct `fetch()` to the API. Tests must exercise the real code paths where bugs live (Go backend combat logic, kro reconciliation, frontend polling).

---

## Current Priority: FEATURE DEVELOPMENT (Issue #95 complete)

All 11 journey tests pass and are enforced by the pre-push hook. Stabilization is complete.
Next tasks may include the open feature requests:
- Issue #92: Helmet, pants, boots equipment slots with buffs
- Issue #25: Multi-phase boss mechanics with HP thresholds
- Issue #20: Loot system enhancements (persistent inventory / item effects)

---

## Key Lessons — Avoid These Regressions

- `lastLootDrop` must be cleared by ALL non-combat patches (backend `processAction` clears it on every action patch)
- `gameOver` and `bossState` must derive from `spec` fields, NOT `status` (status is stale after room transitions)
- `allMonstersDead` must be declared BEFORE `bossState` in JS (TDZ crash risk)
- Boss target matching must use `-boss$` suffix regex, not just the string "boss" (dungeon names can contain "boss")
- Stale Attack CRs from room 1 can be re-processed in room 2 — `enter-room-2` action must delete stale Attack CRs
- Item actions early-return in frontend — no fallthrough to combat/loot code
- `prevInventoryRef` was removed — loot detection uses `lastLootDrop` field from server
- Avoid `${}` in RGD YAML — kro parses it as CEL; use `$()` for bash variable expansion
- `readyWhen` expressions in RGDs must use `${}` wrapper AND the resource's own ID (not `self`) — kro enforces both
- When adding new fields to the Dungeon CR spec in `dungeon-graph.yaml`, always `kubectl delete rgd dungeon-graph` after merge so kro regenerates the CRD schema — Argo CD sync alone does NOT update the CRD field list

---

## Upstream kro Contribution Workflow

This section documents the exact process for contributing to `kubernetes-sigs/kro`.
Fork: `pnz1990/kro` at `/Users/rrroizma/Projects/kro-fork`

### Overview

1. Open an issue on upstream first — get maintainer buy-in before writing code
2. Cut an isolated branch off upstream main — only the relevant files, no krombat-private code
3. Open the PR — follow the strict formatting rules below
4. Wait for EasyCLA + CI + maintainer review

### Step-by-step

```bash
# 0. Sync fork main with upstream
cd /Users/rrroizma/Projects/kro-fork
git checkout main
git fetch upstream   # upstream = https://github.com/kubernetes-sigs/kro
git merge upstream/main
git push origin main

# 1. Create an isolated branch (one contribution per branch)
git checkout -b <short-description>   # e.g. cel-bind-upstream
# NO krombat-private files (lists.go, csv.go, specPatch, stateWrite, etc.)

# 2. Make changes, run tests locally
GOTOOLCHAIN=local go test ./pkg/cel/... 

# 3. Commit — see commit message rules below
git add <files>
git commit -m "feat(scope): short description"

# 4. Push and open PR
git push origin <branch>
gh pr create --repo kubernetes-sigs/kro \
  --title "feat(scope): short description" \
  --body "..."   # see PR body template below
```

### Commit message rules (enforced by k8s-ci-robot)

- Format: `type(scope): description` — e.g. `feat(cel): add ext.Bindings() support`
- **NO `#123` references anywhere in the commit message or body** — the bot rejects them with `do-not-merge/invalid-commit-message`. Put the issue link in the PR body instead (plain URL, not a keyword like `Fixes #123`)
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `perf`
- Keep subject line under 72 chars

### Rewriting a bad commit message (non-interactively)

If the bot flags `do-not-merge/invalid-commit-message`, reword without opening an editor:

```bash
# Create a script that edits the COMMIT_EDITMSG file in place
cat > /tmp/fix-msg.sh << 'SCRIPT'
#!/bin/bash
sed -i '' '/^Fixes #/d' "$1"   # remove the offending line
SCRIPT
chmod +x /tmp/fix-msg.sh

# Rebase: mark the bad commit as 'reword', use the script as the editor
GIT_SEQUENCE_EDITOR="sed -i '' 's/^pick <sha>/reword <sha>/'" \
GIT_EDITOR=/tmp/fix-msg.sh \
git rebase -i <parent-sha>

git push --force origin <branch>
```

### PR body template

```
## What

Short description of the change.

**1. `path/to/file.go`** — what changed and why

**2. `path/to/other.go`** — what changed and why (if applicable)

## Tests

- `pkg/foo/bar_test.go` — TestName: what it covers
```

- **Do NOT use** `Fixes #N`, `Closes #N`, or any closing keyword — reference the issue as a plain URL or omit it
- **Do NOT mention** krombat, game logic, dungeon, damage, etc.
- Keep it factual and concise — see PR #1136 (TwoVarComprehensions) as a good style reference

### CI checks (all must pass before merge)

| Check | What it runs |
|---|---|
| `presubmits-unit-tests` | `go test ./...` |
| `presubmits-integration-tests` | controller integration suite |
| `presubmits-e2e-tests` | end-to-end against a real cluster |
| `presubmits-build-image` | Docker build |
| `presubmits-verify-lint` | golangci-lint |

CI only runs after an org member posts `/ok-to-test` (required for first-time contributors).

### EasyCLA

CNCF requires a signed CLA before any PR can merge. The `linux-foundation-easycla` bot posts a sign link as a comment. Once signed, approval from LF can take minutes to hours — it is automatic after approval, nothing to chase.

Sign at: https://easycla.lfx.linuxfoundation.org

### What NOT to include in upstream PRs

- `pkg/cel/library/csv.go` — krombat-private CSV library
- `specPatch` / `stateWrite` dispatch in `builder.go` — pending maintainer discussion
- Any reference to the krombat game, game logic, or game-specific CEL patterns
- The 3-arg `random.seededInt(min, max, seed)` signature changes — already upstream
- `ext.Bindings()` / `cel.bind()` — **already merged upstream** (PR #1145)
- `lists.setIndex`, `lists.insertAt`, `lists.removeAt` — **in review upstream** (PR #1148)

### Isolation check before opening a PR

```bash
# Verify only the intended files are changed vs upstream main
git diff upstream/main --name-only
```

If anything outside the intended scope appears, do NOT open the PR — clean the branch first.

### Key lessons learned

- `cel.bind()` is a **parse-time macro** — it expands to `ComprehensionKind`, NOT `CallKind`. An `inspectCall` handler checking `fn == "bind"` is dead code and will never fire. The existing `inspectComprehension` handler already handles it via `AccuVar`.
- Always run `GOTOOLCHAIN=local go test ./pkg/cel/...` before pushing — avoids surprises in CI
- The `k8s-ci-robot` scans the full commit body, not just the subject line, for banned keywords
- Once EasyCLA is signed (PR #1145), subsequent PRs from the same GitHub account get `cncf-cla: yes` automatically — no need to re-sign
- New CEL library functions returning `types.NewRefValList` produce `[]ref.Val` from `.Value()`, not `[]interface{}` — test helpers must handle this case explicitly
- Before proposing a new CEL function, check three sources for overlap: `cel-go/ext/lists.go`, `k8s.io/apiserver/pkg/cel/library/lists.go`, and kro's own `pkg/cel/library/`. All three are registered in `BaseDeclarations()`
- Cherry-picking a commit that adds new files to a branch where those files don't exist triggers "modify/delete" conflicts — resolve by `git add`ing the new files and `git rm`ing any fork-private files (e.g. `kro-patched.md`) before `--continue`
- **Always use `cel.TypeParamType("T")` for generic list/map functions, never `cel.DynType`** — `DynType` loses type information at compile time so the return type collapses to `list(dyn)` regardless of input. Use `maps.go` as the reference: `cel.MapType(cel.TypeParamType("K"), cel.TypeParamType("V"))`. Read the existing file in the same package end-to-end before writing any `CompileOptions`.
- **Always add a `TestXxxTypeInference` test for every new CEL library function** that asserts `ast.OutputType().String()` equals the concrete type (e.g. `"list(int)"`). This is the only way to catch `DynType` regressions at test time — runtime tests pass either way.

---

## Infrastructure

- Cluster: `krombat` in `us-west-2`, account `319279230668`
- ECR: `319279230668.dkr.ecr.us-west-2.amazonaws.com/krombat/{backend,frontend}`
- GitHub: `pnz1990/krombat`
- 9 RGDs active, Argo CD syncing from `manifests/`
- CI: `.github/workflows/build-images.yml` — builds on PR, pushes to ECR + rollout restart on main merge

### Terraform

- Working directory: `infra/`
- AWS profile: `319279230668-Admin`
- **Remote state**: S3 bucket `krombat-terraform-state-319279230668`, key `krombat/terraform.tfstate`, region `us-west-2`
- **State locking**: DynamoDB table `krombat-terraform-locks` (issue #425)
- The local `infra/terraform.tfstate` file is **not authoritative** — always use remote state via `terraform init` + `terraform plan/apply`
- **CI does NOT run `terraform apply`** — infra changes require a manual `terraform apply` from `infra/` after merging to main
- CloudWatch dashboards (`krombat-game`, `krombat-application`, `krombat-kubernetes`, `krombat-business`, `krombat-kro`) are all managed in `infra/observability.tf` and require `terraform apply` to take effect

```bash
# Standard terraform workflow
cd infra/
terraform init          # pulls remote state from S3
terraform plan          # review changes
terraform apply         # deploy — requires valid 319279230668-Admin AWS credentials
```
