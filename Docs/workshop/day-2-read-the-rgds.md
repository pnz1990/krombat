# Day 2 — Read the RGDs (2-3 hours)

**Goal:** Read all 9 kro RGDs in the Krombat repo and understand every CEL expression.

No local cluster required. You will read the RGD YAML files on GitHub and use the in-browser CEL Playground at `https://learn-kro.eks.aws.dev` to verify expressions.

---

## Learning outcomes

By the end of Day 2 you will be able to:

- Read a kro RGD YAML file and explain what every section does
- Explain `cel.bind()`, `readyWhen`, `includeWhen`, `specPatch`, and `forEach` from first principles
- Trace a CEL expression from the RGD to its effect on game state
- Use the CEL Playground to evaluate expressions interactively

---

## The 9 RGDs

All RGDs live in `manifests/rgds/` in the repo. The canonical source is:

```
https://github.com/pnz1990/krombat/tree/main/manifests/rgds/
```

Or browse them directly:

| RGD | File | What it manages |
|---|---|---|
| `dungeon-graph` | `dungeon-graph.yaml` | Root graph: Namespace, all child CRs, GameConfig, specPatch nodes |
| `hero-graph` | `hero-graph.yaml` | Hero CR → ConfigMap with maxHP, maxMana, classNote |
| `monster-graph` | `monster-graph.yaml` | Monster CR → ConfigMap with `entityState` (alive/dead) |
| `boss-graph` | `boss-graph.yaml` | Boss CR → ConfigMap with `entityState`, `bossPhase`, `damageMultiplier` |
| `treasure-graph` | `treasure-graph.yaml` | Treasure CR → ConfigMap + Secret with `state` (opened/unopened) |
| `modifier-graph` | `modifier-graph.yaml` | Modifier CR → ConfigMap with `effect` description string |
| `loot-graph` | `loot-graph.yaml` | Loot CR → Secret with item type, rarity, stat, description |
| `attack-graph` | `attack-graph.yaml` | Defines the Attack CRD only — no managed resources |
| `action-graph` | `action-graph.yaml` | Defines the Action CRD only — no managed resources |

---

## Step 1 — Read modifier-graph (30 min)

Start with the simplest RGD: `modifier-graph.yaml`. It is 37 lines.

```yaml
# manifests/rgds/modifier-graph.yaml
spec:
  schema:
    spec:
      dungeonName: string | required=true
      modifierType: string | default="none"
      multiplier: string | default="1.0"
    status:
      effect: "${modifierState.data.effect}"
      modifierType: "${modifierState.data.modifierType}"
      multiplier: "${modifierState.data.multiplier}"

  resources:
    - id: modifierState
      readyWhen:
        - "${modifierState.data.modifierType != ''}"
      template:
        apiVersion: v1
        kind: ConfigMap
        data:
          effect: >-
            ${
              schema.spec.modifierType == 'curse-fortitude' ?
                'Curse of Fortitude: All monsters have 50% more HP.' :
              schema.spec.modifierType == 'blessing-strength' ?
                'Blessing of Strength: Your attacks deal 50% more damage!' :
              'No modifier'
            }
```

**Questions to answer:**

1. What does `readyWhen` do here? When does the resource become "ready"?
2. What happens if `modifierType` is `"blessing-fortune"` — what is the computed `effect` string?
3. The status block has `effect: "${modifierState.data.effect}"`. What does `modifierState` refer to?

*(See [exercises/day-2-exercises.md](exercises/day-2-exercises.md), Q1-Q2)*

---

## Step 2 — Read boss-graph (30 min)

`boss-graph.yaml` is more complex. Focus on these sections:

**Phase derivation:**

```yaml
phase: >-
  ${
    schema.spec.hp <= 0 ? 'defeated' :
    schema.spec.hp * 100 / (schema.spec.maxHP > 0 ? schema.spec.maxHP : 400) > 50 ? 'phase1' :
    schema.spec.hp * 100 / (schema.spec.maxHP > 0 ? schema.spec.maxHP : 400) > 25 ? 'phase2' :
    'phase3'
  }
```

**Damage multiplier:**

```yaml
damageMultiplier: >-
  ${
    schema.spec.hp <= 0 ? '10' :
    schema.spec.hp * 100 / (schema.spec.maxHP > 0 ? schema.spec.maxHP : 400) > 50 ? '10' :
    schema.spec.hp * 100 / (schema.spec.maxHP > 0 ? schema.spec.maxHP : 400) > 25 ? '13' :
    '16'
  }
```

Notice that the HP-percentage expression is repeated three times. Why can't you use `cel.bind()` to avoid this? *(This is a real constraint — research it.)*

**Loot drop via `includeWhen`:**

```yaml
- id: lootCR
  includeWhen:
    - ${schema.spec.hp == 0}
  template:
    apiVersion: game.k8s.example/v1alpha1
    kind: Loot
```

*(See exercises Q3)*

---

## Step 3 — Read dungeon-graph (45 min)

`dungeon-graph.yaml` is the largest RGD (~980 lines). Focus on these patterns:

**forEach fan-out:**

```yaml
- id: monsterCRs
  forEach:
    - idx: "${has(schema.status.game.monsterHP) ? lists.range(size(schema.status.game.monsterHP)) : []}"
  template:
    apiVersion: game.k8s.example/v1alpha1
    kind: Monster
    metadata:
      name: "${schema.metadata.name + '-monster-' + string(idx)}"
    spec:
      hp: ${int(schema.status.game.monsterHP[idx])}
```

This creates one Monster CR per element in `status.game.monsterHP`. With 3 monsters, kro creates 3 CRs.

**State nodes — CEL writes to status.game:**

```yaml
- id: combatResolve
  type: stateNode
  includeWhen:
    - "${schema.spec.attackSeq > kstate(schema.status.game, 'combatProcessedSeq', 0)
        && schema.spec.lastAttackTarget != ''}"
  patch:
    heroHP: ${...}
    monsterHP: ${...}
    bossHP: ${...}
    combatProcessedSeq: "${schema.spec.attackSeq}"
```

A `stateNode` resource is a kro-fork-specific type that writes computed values to `status.game` on the parent CR. This is how CEL expressions on the server can mutate game state — without touching `spec`.

*(See exercises Q4-Q5)*

---

## Step 4 — Read the remaining 6 RGDs (30 min)

Read `hero-graph.yaml`, `monster-graph.yaml`, `treasure-graph.yaml`, `loot-graph.yaml`, `attack-graph.yaml`, and `action-graph.yaml`.

Note for `attack-graph` and `action-graph`: these RGDs contain only a `schema` block and no `resources` block. Their sole purpose is to define a CRD. The Go backend creates Attack and Action CRs, and kro watches them — but kro creates no child resources from them. They are empty RGDs used purely as CRD factories.

---

## Step 5 — CEL Playground verification (30 min)

Open a dungeon at `https://learn-kro.eks.aws.dev` and click the **CEL** button in the kro panel.

Verify each of the following expressions produces the expected output:

| Expression | Expected output |
|---|---|
| `schema.spec.difficulty == "hard" ? "3d20+8" : schema.spec.difficulty == "normal" ? "2d12+6" : "1d20+3"` | The dice formula for your difficulty |
| `schema.status.game.heroHP > 0 ? "alive" : "dead"` | `"alive"` (if your hero is alive) |
| `size(schema.status.game.monsterHP.filter(hp, hp > 0))` | Number of monsters still alive |
| `schema.status.game.bossHP * 100 / 400 > 50 ? "phase1" : schema.status.game.bossHP * 100 / 400 > 25 ? "phase2" : "phase3"` | Current boss phase |

---

## Day 2 exercises

Complete the five questions in [exercises/day-2-exercises.md](exercises/day-2-exercises.md). All answers require reading the RGD YAML files and using the CEL Playground.

---

## Day 2 summary

You have now:
- Read all 9 production kro RGDs
- Understood `readyWhen`, `includeWhen`, `forEach`, and `specPatch` from real examples
- Used the CEL Playground to verify expressions interactively
- Identified the real constraints of CEL (no `let` bindings, no stateful iteration)

Proceed to [Day 3 — Extend](day-3-extend.md).
