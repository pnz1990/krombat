# KREP: CEL Write-Back — Computed Spec Mutations for ResourceGraphDefinitions

**Filed:** 2026-03-09  
**Author:** Krombat project (https://github.com/pnz1990/krombat)  
**Status:** Draft / Proposal  
**Upstream template:** https://github.com/kubernetes-sigs/kro/blob/main/docs/design/proposals/FORMAT.md

---

## Problem Statement

kro's CEL expressions are strictly read-only: they evaluate against an immutable
snapshot of a resource's `spec` and produce derived values that appear in `status`
fields and child resource templates. There is no mechanism for a CEL expression
to write a computed value back to the `spec` of the resource that triggered the
reconcile.

This limitation prevents an entire class of controller patterns where the
interesting logic is a **stateful transition**: take the current state, compute
the next state, persist it. Examples from the Krombat dungeon-RPG project, which
uses kro as its entire game-state layer:

- **Combat resolution**: `heroHP = heroHP - incomingDamage` — the new HP depends
  on the old HP. The result must become the new canonical `spec.heroHP` so the
  next round sees the updated value.
- **Status effect counters**: `poisonTurns = max(0, poisonTurns - 1)` — a
  countdown that must survive across multiple reconcile cycles.
- **Array element mutation**: `monsterHP[i] = max(0, monsterHP[i] - damage)` —
  updating a single slot of a `[]int` field while leaving others unchanged.
- **Mana lifecycle**: `heroMana = min(maxMana, heroMana + regenAmount)` — a
  clamp requiring both the current value and a CEL-derived max.

Today, every one of these patterns requires a bespoke external controller (in
Krombat's case, a Go binary) that:

1. Watches for an event (a new Attack CR appearing, for example),
2. Reads the parent CR's current `spec`,
3. Performs the computation, and
4. Issues a `kubectl patch` back to the parent CR.

This is exactly the reconcile-patch cycle kro already performs internally — just
without the ability to target the parent CR's spec as the output destination.

The result is a split architecture where kro manages the resource graph and
derives coarse state (entity alive/dead, boss phase, loot pre-rolls) but every
mutation that needs to persist across turns must leave kro entirely, re-enter the
cluster via a separate API call, and wait for kro to re-reconcile. For
Kubernetes-native applications that want to use kro as a complete declarative
state machine, this is a significant gap.

---

## Proposal

Introduce a new `specPatch` stanza in the `resources` list of a
ResourceGraphDefinition. When a resource of this type is reconciled, kro
evaluates the CEL expressions under `patch`, then issues a strategic-merge-patch
(or apply-patch) to the **parent instance CR's spec**. The patch is the only side
effect; no child Kubernetes resource is created.

This is not a general-purpose mutation webhook. The scope is narrow:

- Only the **parent instance CR** that triggered the reconcile can be patched.
- Only fields already declared in the RGD's `schema.spec` can be targeted.
- The patch is computed from the same CEL snapshot as all other expressions —
  inputs are the current spec plus any resolved child resource statuses.
- kro applies the patch through its own service account under its existing RBAC
  (which already has update rights on all instances it manages).

### Core concept

```yaml
resources:
  - id: applyDot        # "damage-over-time tick"
    type: specPatch      # <-- new resource type (not a Kubernetes kind)
    patch:
      heroHP:   "${max(0, schema.spec.heroHP   - (schema.spec.poisonTurns > 0 ? 5 : 0) - (schema.spec.burnTurns > 0 ? 8 : 0))}"
      poisonTurns: "${max(0, schema.spec.poisonTurns - 1)}"
      burnTurns:   "${max(0, schema.spec.burnTurns   - 1)}"
    includeWhen:
      - "${schema.spec.poisonTurns > 0 || schema.spec.burnTurns > 0}"
```

When kro reconciles an instance and reaches this node in the DAG:

1. All CEL expressions under `patch` are evaluated.
2. If the computed values differ from the current spec values, kro issues a
   server-side apply patch to the parent instance CR.
3. The patch triggers a new reconcile cycle (standard Kubernetes watch
   semantics).
4. The `specPatch` node is considered "ready" once the patch has been applied
   and the parent CR's `resourceVersion` has advanced.

### Relationship to the DAG

A `specPatch` node participates in the dependency graph like any other resource:

- It can declare dependencies on child resource statuses (e.g.,
  `${attackCR.metadata.uid}` as the dice seed).
- Other resources can declare `readyWhen` conditions that wait for the `specPatch`
  to have applied (using the parent CR's updated spec values).
- `includeWhen` controls whether the patch is applied at all (idempotency guard).

### Idempotency

Because kro reconciles continuously, a `specPatch` node must be safe to
re-evaluate. If the computed values already match the current spec, kro must
skip the patch (a no-op). The `includeWhen` guard is the primary mechanism for
this; kro should also compare the computed patch against the current spec before
issuing the API call.

---

## Motivation: Krombat as a Concrete Case Study

Krombat (https://github.com/pnz1990/krombat) is a turn-based dungeon RPG where
every piece of game state lives in a Kubernetes Custom Resource. The architecture
was designed to demonstrate Kubernetes as a general-purpose state machine, with
kro ResourceGraphDefinitions as the orchestration layer.

Today, Krombat uses kro for everything it can:

| What kro computes today | Where it's used |
|---|---|
| Boss phase (`phase1`/`phase2`/`phase3`) and damage multiplier | Go backend reads at `handlers.go:672` |
| Entity alive/dead states (hero, monster, boss) | Frontend and leaderboard |
| Victory/defeat flags | Leaderboard at dungeon delete |
| Loot pre-rolls (type, rarity, stat) via `random.seededString` | Frontend display |
| Modifier/loot description strings | Frontend display |
| Config values (`diceFormula`, `maxHP` tables) | UI labels |

Everything that requires **writing a result back to spec** lives in a Go binary
(`backend/internal/handlers/handlers.go`, ~2000 lines) that is architecturally
doing the same job as kro — watching CRs, computing transitions, patching state —
just without kro's resource-graph machinery.

If `specPatch` existed, the following transitions could move into RGDs:

| Transition | Current Go lines | `specPatch` expression |
|---|---|---|
| DoT tick (poison/burn/stun) | `handlers.go:724–760` | 3-field patch, `includeWhen: any DoT active` |
| Monster death registration | `handlers.go:1096–1122` | `monsterHP[i] = 0` on kill, `includeWhen: attack landed` |
| Mana regen on kill | `handlers.go:1180–1195` | `heroMana = min(maxMana, heroMana + regenAmount)` |
| HP clamp after counter-attack | `handlers.go:1200–1215` | `heroHP = max(0, heroHP - counterDamage)` |
| Room transition HP scaling | `handlers.go:1360–1410` | `monsterHP[i] *= 1.5`, `bossHP *= 1.3` |

The irreducible remainder that cannot move to kro even with `specPatch`:

- **Per-request randomness**: dice rolls use the Attack CR's UID as entropy
  (assigned by the API server at the moment the CR is created). This seed is
  inherently not available until after the Attack CR exists. `specPatch` could
  reference it as `${attackCR.metadata.uid}`, but only if the DAG resolves
  the Attack CR before evaluating the dice-roll patch — which requires careful
  `readyWhen` ordering.
- **Sequential multi-step dependencies within a single turn**: step 4 uses the
  output of step 3. With `specPatch` this becomes a chain of separate reconcile
  cycles (patch A → re-reconcile → patch B → re-reconcile). Each patch triggers
  a new cycle, so a 12-step combat turn becomes 12 reconcile cycles. This is
  correct but has latency implications (see Trade-offs below).

---

## Design Details

### New `type` field on resource entries

The `resources` list today implicitly creates a Kubernetes resource from the
`template` stanza. This proposal adds an optional `type` field:

```yaml
resources:
  - id: myResource
    type: specPatch    # new; omit for existing behavior (creates K8s resource)
    patch:
      fieldA: "${expr}"
      fieldB: "${expr}"
    includeWhen:
      - "${condition}"
```

When `type: specPatch` is set, the `template` stanza is disallowed (schema
validation error). The `patch` stanza is required.

### `patch` stanza

Keys under `patch` are field names from the parent instance CR's `spec`. Nested
fields use dot notation: `status.heroHP` is not valid (only `spec` fields can be
patched); `inventory` patches `spec.inventory`. Array-element patches require a
separate discussion (see Limitations below).

Values are CEL expressions (same `${}` syntax as all other kro CEL fields).

### Conflict resolution and retry

kro's service account already holds `update` and `patch` rights on all instance
CRs. When applying the patch:

1. kro issues a strategic-merge-patch with `resourceVersion` set (optimistic
   concurrency).
2. On `409 Conflict`, kro re-reads the latest spec and re-evaluates the CEL
   expressions before retrying (standard controller pattern).
3. Retry uses exponential backoff with jitter, same as other kro reconcile
   failures.

### `readyWhen` for `specPatch`

The `specPatch` node is ready when the patch has been applied and the observed
parent spec matches the computed values. Suggested default `readyWhen`:

```
"${schema.spec.fieldA == <computed-value> && schema.spec.fieldB == <computed-value>}"
```

kro can auto-generate this by comparing each patched field against its computed
expression. Users can override with explicit `readyWhen` if needed.

### Schema validation

kro validates at RGD admission time:
- All keys in `patch` are declared fields in `schema.spec`.
- CEL types match the declared field types (e.g., no patching an `int` field
  with a `string` expression).
- No `template` stanza alongside `type: specPatch`.

---

## Other Solutions Considered

### Job-based write-back (the original Krombat approach)

A Kubernetes Job (using `images/job-runner` in Krombat — a minimal bash+kubectl
image) would: read the `combatResult` ConfigMap written by kro CEL, compute the
delta, and `kubectl patch` the Dungeon CR.

**Why not chosen**: 30–60 second cold-start on Job pod scheduling made this
unusable for interactive gameplay. Even with pre-warmed node pools the latency
was prohibitive. The approach was abandoned in favor of the Go backend.

### External admission webhook

A mutating webhook could intercept `spec` writes and augment them with computed
fields.

**Why not chosen**: Webhooks run synchronously in the API server request path
(adds latency to every write), require a highly-available deployment, and cannot
observe child resource statuses (they only see the resource being admitted).
Combat math in Krombat depends on child resource statuses (attack CR UID, boss
phase from boss-graph).

### CEL `let` bindings (standard CEL roadmap)

CEL itself is adding `let` bindings which would allow intermediate values to be
threaded through a single expression. This would help with the multi-step
sequential problem within one reconcile cycle.

**Why not sufficient alone**: `let` bindings solve the expression-composition
problem but not the write-back problem. Even with `let`, the result of the
expression can only appear in a `status` field or child resource template — it
still cannot update `spec.heroHP`.

### CRD defaulting via `x-kubernetes-validations` (CEL in the API server)

Kubernetes CRD validation rules (CEL) can enforce constraints on `spec` at
admission time and transition rules. Server-side apply can set defaults.

**Why not sufficient**: These run at admission, not at reconcile time. They
cannot observe external state (child CRs, other resources). They are
validation/defaulting, not arbitrary computed transitions. They do not integrate
with kro's DAG ordering.

---

## Scope

### In scope

- `type: specPatch` resource entries in RGDs
- `patch` stanza with field names and CEL value expressions
- Integration with existing `includeWhen` and `readyWhen`
- Schema validation of patch targets and expression types
- Idempotency: skip patch when computed values match current spec
- Conflict retry with optimistic concurrency
- DAG ordering: `specPatch` nodes can depend on child resource statuses

### Out of scope

- Patching resources **other than the parent instance CR** (no cross-resource
  mutations)
- Patching `status` fields (kro already owns status; `specPatch` targets spec
  only)
- Array element mutations (e.g., `monsterHP[2] = 0`) — this requires list-set
  semantics not currently in CEL; a follow-up proposal should address
  `lists.set(list, index, value)` as a kro CEL extension
- Multi-pass reconcile orchestration (patch A depends on the result of a previous
  specPatch B within the same reconcile cycle) — each specPatch triggers a new
  reconcile; chains of patches naturally sequence via multiple reconcile cycles
- Batch/transactional patches (all-or-nothing across multiple specPatch nodes)
- User-defined CEL functions (separate proposal scope)

---

## Trade-offs and Risks

### Reconcile amplification

Each `specPatch` that writes a new value triggers a new reconcile cycle (because
the parent CR's spec changes). A combat turn with 4 specPatch nodes that all fire
becomes 4 sequential reconcile cycles. At kro's typical reconcile latency
(sub-second for ConfigMap/CR creation), this adds ~1–4 seconds per turn for a
12-step combat sequence.

**Mitigation**: Group related fields into a single `specPatch` node. In Krombat,
DoT application (heroHP, poisonTurns, burnTurns, stunTurns) is one logical step
and should be one specPatch node — 4 fields, one patch, one reconcile cycle.

### Infinite reconcile loops

If a `specPatch` writes a value that causes the same `specPatch` to fire again,
the controller loops indefinitely. Example: `heroHP: "${schema.spec.heroHP - 1}"` 
with no `includeWhen` guard.

**Mitigation**: The `includeWhen` guard is mandatory for any specPatch that
modifies a field it also reads. kro should warn at admission time when a
`specPatch` reads and writes the same field without an `includeWhen` expression
that converges.

### RBAC and audit

kro patching a user's CR spec under its own service account means kro's SA
becomes more powerful. Audit logs will show kro (not the user) as the actor for
spec mutations.

**Mitigation**: kro already has update rights on all instance CRs it manages.
The audit log should record the RGD and resource ID that triggered the patch
(available as patch annotations or ownerReference fields).

---

## Testing Strategy

### Unit tests

- CEL expression evaluation for each patch field type (`int`, `string`, `[]int`,
  `bool`)
- Idempotency: verify no API call is issued when computed values match current
  spec
- Conflict retry: verify re-evaluation on 409 and correct retry backoff
- Schema validation: invalid patch targets and type mismatches produce
  informative errors at admission

### Integration / e2e tests

Using Krombat's existing test infrastructure (`tests/run.sh`, `tests/guardrails.sh`):

- A minimal RGD with one `specPatch` node that decrements a counter field; verify
  the counter decrements to 0 and the `includeWhen` guard stops further patches
- A `specPatch` that depends on a child resource status (reading
  `attackCR.metadata.uid`); verify the patch only fires after the child CR
  appears
- A chain of two `specPatch` nodes (A patches field X, B reads field X and
  patches field Y); verify both fields reach expected values across two reconcile
  cycles
- Conflict scenario: simulate concurrent writes; verify retry converges

---

## Appendix: Krombat RGD Sketch

Below is a sketch of what the Krombat `dungeon-graph.yaml` would look like with
`specPatch` support. This is illustrative, not a working manifest.

```yaml
# manifests/rgds/dungeon-graph.yaml (hypothetical, with specPatch)
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: dungeon-graph
spec:
  schema:
    apiVersion: v1alpha1
    kind: Dungeon
    spec:
      heroHP:      "integer"
      bossHP:      "integer"
      poisonTurns: "integer"
      burnTurns:   "integer"
      stunTurns:   "integer"
      heroMana:    "integer"
      # ... (other fields)
  resources:
    # --- existing: create the hero CR ---
    - id: heroCR
      template:
        apiVersion: krombat.run/v1alpha1
        kind: Hero
        metadata:
          name: "${schema.metadata.name}-hero"
          namespace: "${schema.metadata.namespace}"
        spec:
          class: "${schema.spec.heroClass}"

    # --- existing: create boss CR, reads heroCR status for bossPhase ---
    - id: bossCR
      template:
        apiVersion: krombat.run/v1alpha1
        kind: Boss
        metadata:
          name: "${schema.metadata.name}-boss"
        spec:
          hp: "${schema.spec.bossHP}"

    # --- NEW: apply DoT tick every reconcile when any DoT is active ---
    - id: applyDoT
      type: specPatch
      includeWhen:
        - "${schema.spec.poisonTurns > 0 || schema.spec.burnTurns > 0 || schema.spec.stunTurns > 0}"
      patch:
        heroHP:      "${max(0, schema.spec.heroHP - (schema.spec.poisonTurns > 0 ? 5 : 0) - (schema.spec.burnTurns > 0 ? 8 : 0))}"
        poisonTurns: "${max(0, schema.spec.poisonTurns - 1)}"
        burnTurns:   "${max(0, schema.spec.burnTurns   - 1)}"
        stunTurns:   "${max(0, schema.spec.stunTurns   - 1)}"

    # --- NEW: mana regen when a monster is killed this turn ---
    # (requires a loot CR to exist — which is created by includeWhen: hp==0 in monster-graph)
    - id: manaRegenOnKill
      type: specPatch
      includeWhen:
        - "${size(schema.spec.lastLootDrop) > 0 && schema.spec.heroClass == 'mage'}"
      patch:
        heroMana: "${min(8, schema.spec.heroMana + 2)}"
```

The remaining combat logic (dice roll using Attack CR UID as seed, class damage
modifier, counter-attack chain) still requires per-request entropy not available
from a fixed-seed CEL expression. That portion of the game engine remains in the
Go backend until kro gains a mechanism to reference freshly-created CR UIDs as
CEL inputs within the same reconcile cycle.

---

## Discussion Notes

This proposal was drafted from operational experience building Krombat, a
Kubernetes-native turn-based RPG that exposes kro's current write-back
limitation as a hard architectural constraint. The full migration analysis is
at `Docs/kro-cel-migration-analysis.md` in the Krombat repository.

The core insight is: **kro already implements the reconcile-patch loop**. The
only missing piece is directing the output of that loop back to the parent
instance's `spec` rather than exclusively to child resource templates and
`status` fields. `specPatch` is the minimal surface area needed to unlock a
large class of stateful Kubernetes-native applications.
