# kro CEL Migration Analysis: Can Combat Move to kro?

**Date:** 2026-03-09
**Status:** Research / Design
**Author:** AI Agent (session notes)

---

## Background

Krombat uses kro ResourceGraphDefinitions to manage the Kubernetes resource graph for each dungeon (namespace, hero, monsters, boss, treasure, modifier, loot). kro uses CEL (Common Expression Language) to derive status fields and configure child resources. The Go backend (`handlers.go`) is the actual game engine: it runs all combat math, applies item effects, manages status conditions, and writes results back to the Dungeon CR spec via `kubectl patch`.

This document answers: **which parts of the backend can be moved into kro CEL today, which cannot, and why?**

---

## Current Architecture Summary

### What kro CEL does today (active, load-bearing)

| RGD | CEL computes | Backend reads it? |
|---|---|---|
| `boss-graph` | `entityState`, `bossPhase`, `damageMultiplier`, `specialAttackChance` | **Yes** — `bossDamageMultiplier` and `bossPhase` read from `dungeonStatus` at `handlers.go:672-677` |
| `hero-graph` | `entityState`, `maxHP`, `damageModifier`, `defense`, `dodgeChance` | Partially — `maxHeroHP` read from status for display |
| `monster-graph` | `entityState` per monster | Via `livingMonsters` count in `dungeon-graph` status |
| `dungeon-graph` | `victory`, `defeat`, `bossState`, `livingMonsters`, `maxBossHP`, `diceFormula` | `victory`/`defeat` used by leaderboard; `diceFormula` used by UI label only |
| `modifier-graph` | `effect` (human-readable description string) | Not read by backend — UI reads from dungeon status |
| `loot-graph` | `description` string per loot item | Not read by backend — UI reads from Loot CR status |
| `treasure-graph` | `state` (opened/unopened), `loot` key string | Not read by backend — UI reads from dungeon status |
| `monster-graph` + `boss-graph` | Loot CR creation via `includeWhen: hp==0`, seeded item type/rarity/stat | Backend mirrors this exact math in `computeMonsterLoot()` / `computeBossLoot()` to generate item name strings |

### What Go does today (the game engine)

All of the following lives in `backend/internal/handlers/handlers.go`:

1. **Dice rolling** — FNV-1a hash of Attack CR UID, per-difficulty formula (`rollDice`, `seededRoll`)
2. **Class damage modifiers** — mage 1.3x (with mana), rogue 1.1x, backstab 3x
3. **Dungeon modifier effects** — curse-darkness -25%, blessing-strength +50%, blessing-fortune 20% crit
4. **Weapon/helmet/amulet bonuses** — damage additions and multipliers
5. **Ring regen** — HP restore per round
6. **DoT application** — poison -5/turn, burn -8/turn, stun skip
7. **Counter-attack calculation** — per-difficulty base × alive monsters or boss phase multiplier
8. **Defense math** — armor % reduction, shield block roll, warrior 25% reduction, rogue 25% dodge, pants dodge
9. **Taunt reduction** — 60% counter-attack reduction for 1 turn
10. **One-shot protection** — floor: single counter cannot drop hero below 1 HP
11. **Status effect infliction** — boss stun/burn/poison rolls; archer stun chance; shaman heal chance
12. **Boots status resist** — chance to resist incoming status effect
13. **Mana lifecycle** — mage consumption/regen, exhaustion penalty, heal spell
14. **Loot drop detection** — kill transition (oldHP > 0 && newHP == 0), drop chance roll, inventory add
15. **Item equip/use** — all 27 equip cases (9 types × 3 rarities), potion healing (class-clamped)
16. **Room transitions** — Room 2 HP scaling (monsters ×1.5, boss ×1.3), modifier adjustment, monster type reassignment, state resets
17. **Leaderboard recording** — outcome derivation, turn counting

---

## What CEL Can and Cannot Do

CEL (Common Expression Language) is a **pure, side-effect-free expression evaluator**. It evaluates a single expression over an immutable input snapshot and returns a value. It does not:

- **Mutate state** — CEL cannot write to any field of any resource
- **Execute sequentially** — all CEL expressions in a kro RGD evaluate simultaneously from one snapshot
- **Use randomness** — CEL has no `rand()` equivalent (kro adds `random.seededString` — see below)
- **Perform I/O** — no HTTP calls, no Kubernetes API calls from within CEL
- **Use loops or recursion** — no for-loops; list comprehensions are the only iteration
- **Maintain mutable state across evaluations** — each reconcile is a fresh evaluation

kro adds two CEL extensions beyond the standard library:
- `random.seededString(length, seed)` — returns a deterministic pseudo-random string from a seed
- `lists.range(n)` — returns `[0, 1, ..., n-1]`

---

## Migration Analysis: Category by Category

### Category 1: Already in kro CEL — nothing to change

These are already correctly computed by kro and read by the backend or frontend:

- Boss phase (`phase1`/`phase2`/`phase3`) and damage multiplier
- Entity alive/dead states (hero, monster, boss)
- Victory/defeat flags
- Loot item type, rarity, stat, drop chance (pre-rolled at monster spawn via `random.seededString`)
- Modifier flavor text
- Dungeon config values (maxMonsterHP, maxBossHP, diceFormula)

### Category 2: Computable in CEL but not worth moving

These could be expressed as CEL but the backend already derives them correctly and there is no benefit to duplicating them in kro:

**a) Static class tables** — `maxHP`, `damageModifier`, `defense`, `dodgeChance`

These are already in `hero-graph.yaml`. The backend also hardcodes them (`classMaxHP()`, `classMaxMana()`). Having both in sync is workable today. Moving the backend to *read* from kro status would add a round-trip with potential stale-status risk (kro status is async).

**b) Modifier description strings** — already in `modifier-graph.yaml`. Backend doesn't need them.

**c) Config values** — `diceFormula`, counter base values are in `gameConfig` ConfigMap. Backend re-derives them from the difficulty string because the ConfigMap read would add latency.

### Category 3: Cannot be done in CEL — fundamental blockers

#### 3a. Dice rolling with per-request randomness

```go
// handlers.go:866-868
attackUID := string(attackResult.GetUID())
baseDamage := rollDice(difficulty, isBossTarget, attackUID)
```

The seed is the **Attack CR's UID**, assigned by the Kubernetes API server at the moment the Attack CR is created. This is the only truly unpredictable input. kro's `random.seededString` uses a fixed seed — dungeon name or similar — meaning the same dungeon always produces the same loot. For combat, using a fixed seed would make every fight deterministic from creation time.

**Could this be worked around?** Only if kro could reference a frequently-changing field as the seed (e.g., the Attack CR's UID). kro does support `externalRef` references to other CRs, but even if dungeon-graph read the Attack CR UID and passed it to a CEL expression, the output would be a ConfigMap value — kro cannot then write that value back to `spec.heroHP` on the Dungeon CR. The write-back is still blocked by item 3b below.

#### 3b. Writing computed results back to the Dungeon CR spec

This is the core architectural blocker. After rolling dice and computing `newHeroHP`, `newBossHP`, `newMonsterHP`, etc., the backend does:

```go
// handlers.go:1297
patch := map[string]interface{}{"spec": patchSpec}
return h.patchAndRespond(ctx, ns, name, patch, w)
```

CEL expressions in kro produce **read-only derived values** — they appear in `status` fields and in child resource templates. They cannot patch the parent CR's `spec`. The Dungeon CR spec is the ground truth; kro reads it and derives status from it. There is no mechanism for kro to write back to the spec that triggered it.

**Could a child resource do the write-back?** No. Child resources (ConfigMaps, CRs) created by kro are owned by kro and reconciled from spec. None have the ability or RBAC to patch other CRs.

**The original bash Job approach** (referenced in `images/job-runner/`): a Kubernetes Job would `kubectl get` the combatResult ConfigMap (written by CEL), compute the delta, and `kubectl patch` the Dungeon CR. This worked but had 30–60 second cold-start latency and was abandoned.

#### 3c. Sequential multi-step computation

A single combat turn involves 8–12 ordered steps that depend on each other:

```
1. Apply DoT (modifies heroHP, poisonTurns, burnTurns, stunTurns)
2. Check stun → zeroes effectiveDamage
3. Roll dice (needs Attack CR UID from step 0)
4. Apply class modifier (needs heroMana from step 1 if mage)
5. Apply dungeon modifier (needs step 4 result)
6. Apply weapon/helmet/amulet bonuses (needs step 5 result)
7. Apply ring regen (modifies heroHP before enemy turn)
8. Apply counter-attack (needs step 6 result, boss phase multiplier, current heroHP)
9. Apply armor/shield/dodge/taunt to counter (needs step 8)
10. Apply one-shot floor to counter (needs step 8-9)
11. Apply status effect infliction (uses separate roll, separate seed)
12. Accumulate mana changes, loot drops, inventory mutations
```

CEL evaluates all expressions simultaneously from a single input snapshot. Steps 4, 8, 9, 10, 11 depend on intermediate values computed in earlier steps. This cannot be expressed in a single CEL evaluation without let-bindings (which CEL does not have) or a cascade of separate reconcile passes (which kro does not support in sequence).

#### 3d. Mutable array operations (monsterHP)

```go
newMonsterHP[idxInt] = newHP  // handlers.go:1122
```

CEL has no mutable list operations. It can build a new list with `map()` but the result must be written somewhere — and writing to `spec.monsterHP` hits the same write-back blocker from 3b.

#### 3e. Conditional logic with cross-step state

Shaman heal (handlers.go:1248–1282) reads the freshly-mutated `newMonsterHP` (already updated by the attack this turn) to decide which monster to heal and by how much. It requires the intermediate state from step 8 as input. This is a two-pass dependency — impossible in a single CEL evaluation.

#### 3f. Inventory management

Inventory is a CSV string (`"weapon-rare,hppotion-common"`). Adding/removing items requires string manipulation (split, filter, join) combined with a capacity check. CEL can express string operations but cannot write the result back to `spec.inventory`.

---

## What a kro-native Architecture Would Look Like

If kro gained the following capabilities, more of the game engine could migrate:

### Required kro enhancement: `spec-patch` resource type

A hypothetical kro resource type that, on reconcile, patches a specified CR's spec with CEL-derived values:

```yaml
# hypothetical — does not exist today
- id: combatResult
  template:
    apiVersion: kro.run/v1alpha1
    kind: SpecPatch
    target:
      ref: ${schema.metadata.name}
      gvr: game.k8s.example/v1alpha1/dungeons
      namespace: ${schema.metadata.namespace}
    patch:
      heroHP: "${schema.spec.heroHP - computedDamage}"
      bossHP: "${schema.spec.bossHP - computedHeroDamage}"
```

**Blocker:** This would require kro to hold a write lock, perform a read-modify-write, and retry on conflict. This is essentially building a Kubernetes controller inside kro — which is what the backend Go code already is.

### Required kro enhancement: multi-pass reconciliation with let-bindings

CEL needs `let` bindings to thread intermediate results through a pipeline:

```cel
// hypothetical CEL with let-bindings
let doTHP = schema.spec.heroHP - (schema.spec.poisonTurns > 0 ? 5 : 0);
let baseDmg = rollFromUID(attackCR.metadata.uid, schema.spec.difficulty);
let effectiveDmg = baseDmg * classMult(schema.spec.heroClass);
// ... etc.
```

CEL itself is adding `let` bindings in a future version, but kro would also need to sequence multiple passes.

### Required kro enhancement: mutable list operations

CEL needs a `listSet(list, index, value)` function to update a single element of the `monsterHP` array without rewriting all elements.

---

## What Is Realistic Today

Given current kro capabilities, here is a realistic division of responsibility:

| Component | Owner | Rationale |
|---|---|---|
| Resource graph creation (namespace, child CRs) | kro | Already working |
| Entity state derivation (alive/dead/defeated) | kro | Already working, read by backend |
| Boss phase + damage multiplier | kro | Already working, read by backend (`handlers.go:672`) |
| Loot pre-roll (type, rarity, stat, drop chance) | kro | Already working via `random.seededString` |
| Victory/defeat flags | kro | Already working, read by leaderboard |
| Config values (diceFormula, maxHP tables) | kro | Already working, used by UI |
| Modifier/loot description strings | kro | Already working, used by UI |
| **All combat math** | **Go backend** | Requires randomness, sequential steps, write-back |
| **Item equip/use effects** | **Go backend** | Requires write-back to spec |
| **Status effect infliction/resist** | **Go backend** | Requires sequential dice rolls + write-back |
| **Room transitions** | **Go backend** | Requires batch spec mutation |
| **Loot inventory mutations** | **Go backend** | Requires read-modify-write on CSV string |
| **Leaderboard** | **Go backend** | External storage, not expressible in CEL |

The one realistic improvement: the backend could read more values **from** kro status instead of re-deriving them from spec. Currently only `bossDamageMultiplier` and `bossPhase` are read from kro status. The `heroDefense`, `heroDodgeChance`, `heroDamageModifier` from `hero-graph` status could also be read, eliminating the duplicated class tables in Go. However this adds a kro reconcile round-trip as a dependency, and the values never change during a dungeon run — so there is no practical bug risk to leaving them duplicated.

---

## Summary

The combat engine **cannot** be moved to kro CEL with the current kro feature set. The three fundamental blockers are:

1. **No write-back** — CEL computes derived read-only values; it cannot patch `spec` on any CR
2. **No sequencing** — all expressions evaluate simultaneously from one snapshot; combat requires ordered steps where each step's output is the next step's input
3. **No per-request randomness** — seeded CEL uses fixed seeds; meaningful combat requires entropy from the Attack CR's UID (assigned at request time)

The existing architecture — kro manages the resource graph and derives coarse state (entity alive/dead, boss phase), Go backend runs the per-turn simulation and patches spec — is the correct split given current kro capabilities. The game demonstrates Kubernetes as a state machine without requiring kro to be a general-purpose game engine.

If kro evolves to support spec-patch write-back and multi-pass CEL evaluation, this analysis should be revisited.
