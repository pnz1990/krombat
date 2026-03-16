/**
 * KroTeach — in-game kro teaching layer
 *
 * Components:
 *  - InsightCard      : slide-in contextual card triggered by game events
 *  - KroGlossary      : progressive concept glossary (fills in as player triggers concepts)
 *  - kroAnnotate()    : returns kro commentary + CEL snippets for a K8s log entry
 *  - KRO_STATUS_TIPS  : per-field tooltip copy for the status bar
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { PixelIcon } from './PixelIcon'

// ─── Types ──────────────────────────────────────────────────────────────────

export type KroConceptId =
  | 'rgd'
  | 'spec-schema'
  | 'schema-validation'
  | 'resource-chaining'
  | 'cel-basics'
  | 'cel-ternary'
  | 'forEach'
  | 'includeWhen'
  | 'readyWhen'
  | 'status-aggregation'
  | 'seeded-random'
  | 'secret-output'
  | 'empty-rgd'
  | 'spec-mutation'
  | 'externalRef'
  | 'status-conditions'
  | 'reconcile-loop'
  | 'resourceGroup-api'
  | 'cel-has-macro'
  | 'ownerReferences'
  | 'cel-playground'
  | 'cel-filter'
  | 'cel-string-ops'
  | 'spec-patch'

export interface KroConcept {
  id: KroConceptId
  title: string
  tagline: string
  body: string
  snippet: string   // YAML/CEL snippet to show
  learnMore: string // short description of where to look in the repo
}

export interface InsightTrigger {
  conceptId: KroConceptId
  headline: string   // one-line "what just happened" in game terms
}

// ─── Concept Definitions ─────────────────────────────────────────────────────

export const KRO_CONCEPTS: Record<KroConceptId, KroConcept> = {
  'rgd': {
    id: 'rgd',
    title: 'ResourceGraphDefinition (RGD)',
    tagline: 'One CR. Sixteen resources. Zero imperative code.',
    body: `A ResourceGraphDefinition is a kro custom resource that describes a graph of Kubernetes resources.
When you applied the Dungeon CR, kro read the dungeon-graph RGD and automatically created a Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, 1 GameConfig ConfigMap, and 9 specPatch nodes — all from a single \`kubectl apply\`.`,
    snippet: `# manifests/rgds/dungeon-graph.yaml
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: dungeon-graph
spec:
  schema:
    apiVersion: game.k8s.example/v1alpha1
    kind: Dungeon
    spec:
      monsters: integer | default=3 minimum=1 maximum=10
      difficulty: string | default="normal" enum=easy,normal,hard
      heroClass: string | default="warrior"
      # ... 30+ more typed fields
  resources:
    - id: namespace
      template: # Namespace resource ...
    - id: heroCR
      template: # Hero CR resource ...
    - id: monsterCRs  # forEach fan-out!
      forEach:
        - idx: "\${lists.range(size(schema.spec.monsterHP))}"
      template: # ...`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml',
  },

  'spec-schema': {
    id: 'spec-schema',
    title: 'Typed spec.schema with defaults & enums',
    tagline: 'kro validates and defaults your CR fields at admission time.',
    body: `kro's RGD \`spec.schema\` block is an OpenAPI-compatible schema. Fields can have types, defaults, enums, and validation constraints.
When you chose "hard" difficulty, kro validated that value against the enum \`[easy, normal, hard]\` before the CR was stored. Defaults mean you never need to specify every field.`,
    snippet: `# Inside dungeon-graph RGD — spec.schema block
spec:
  schema:
    spec:
      difficulty:
        type: string
        default: "normal"
        enum: [easy, normal, hard]
      monsters:
        type: integer
        default: 3
        minimum: 1
        maximum: 10
      heroClass:
        type: string
        default: "warrior"
        enum: [warrior, mage, rogue]`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — spec.schema section',
  },

  'schema-validation': {
    id: 'schema-validation',
    title: 'CRD Admission Validation',
    tagline: 'kro generates OpenAPI v3 rules — bad specs are rejected before reconcile.',
    body: `When kro registers your RGD, it compiles the \`spec.schema\` block into an OpenAPI v3 schema that Kubernetes embeds directly into the CRD. This means the API server enforces your types, enums, and constraints at admission time — before kro ever sees the request.

If you tried to create a dungeon with \`difficulty: legendary\` (not in the enum), the API server would reject it with a 422 Unprocessable Entity. No bad state ever reaches kro.`,
    snippet: `# kro compiles spec.schema → OpenAPI v3 CRD validation
# kubectl get crd dungeons.kro.run -o yaml | grep -A 20 validation
validation:
  openAPIV3Schema:
    properties:
      spec:
        properties:
          difficulty:
            enum: [easy, normal, hard]
            type: string
          heroClass:
            enum: [warrior, mage, rogue]
            type: string`,
    learnMore: 'kubectl get crd dungeons.kro.run -o yaml — look for openAPIV3Schema',
  },

  'resource-chaining': {
    id: 'resource-chaining',
    title: 'Resource Chaining',
    tagline: 'Child CR status flows back to parent status automatically.',
    body: `dungeon-graph creates a Hero CR. The Hero CR is handled by hero-graph, which creates a heroState ConfigMap. dungeon-graph's status block reads from that ConfigMap (via \`${'{'}heroCR.status.maxHP{'}'}\`) and exposes it as the dungeon's own status.
This is resource chaining: each RGD handles one layer, and kro wires the outputs together.`,
    snippet: `# dungeon-graph status — reading from child CRs
status:
  maxHeroHP: \${heroCR.status.?maxHP.orValue('100')}
  livingMonsters: >-
    \${size(monsterCRs.filter(m,
      m.status.?entityState.orValue('alive') == 'alive'))}
  bossState: \${bossCR.status.?entityState.orValue('pending')}
  treasureState: \${treasureCR.status.?treasureState.orValue('unopened')}`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — status block',
  },

  'cel-basics': {
    id: 'cel-basics',
    title: 'CEL — Common Expression Language',
    tagline: 'All game logic is pure CEL inside YAML. No controllers.',
    body: `CEL (Common Expression Language) is the expression engine kro uses inside \${...} blocks. Every HP transition, state change, and status derivation in this game is a CEL expression evaluated at reconcile time — no custom controllers needed for game logic.
The damage you just dealt was computed by CEL inside a specPatch node in dungeon-graph — the same node that also decrements HP, applies status effects, and rolls loot drops.`,
    snippet: `# dungeon-graph — combatResolve specPatch node (damage computation)
# CEL re-evaluates every time attackSeq advances past combatProcessedSeq
- id: combatResolve
  type: specPatch
  includeWhen:
    - "\${schema.spec.attackSeq > schema.spec.combatProcessedSeq
        && schema.spec.lastAttackTarget != ''}"
  patch:
    # Dice roll seeded by lastAttackSeed for deterministic replay
    monsterHP: >-
      \${schema.spec.difficulty == 'easy'
        ? lists.set(schema.spec.monsterHP, idx,
            schema.spec.monsterHP[idx] - (roll + 2))
        : ...}
    combatProcessedSeq: "\${schema.spec.attackSeq}"`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — combatResolve specPatch node',
  },

  'cel-ternary': {
    id: 'cel-ternary',
    title: 'CEL Ternary Chains — State Machines in YAML',
    tagline: 'Multi-state machines expressed as nested ternaries.',
    body: `CEL does not have if/else blocks, but nested ternary expressions (\`condition ? a : b\`) create powerful state machines.
The boss transitions between three states — pending, ready, and defeated — using a single two-level ternary. No controller code, no webhook: pure CEL evaluated by kro on every reconcile.`,
    snippet: `# boss-graph — entityState CEL ternary
# Reads monstersAlive (computed by dungeon-graph, forwarded as spec field)
data:
  entityState: >-
    \${schema.spec.hp > 0
      ? (schema.spec.monstersAlive == 0 ? 'ready' : 'pending')
      : 'defeated'}

# hero-graph — entityState (simpler, 2-state)
data:
  entityState: "\${schema.spec.hp > 0 ? 'alive' : 'defeated'}"`,
    learnMore: 'manifests/rgds/boss-graph.yaml and hero-graph.yaml',
  },

  'forEach': {
    id: 'forEach',
    title: 'forEach — Dynamic Resource Fan-out',
    tagline: 'One spec field → N child resources, computed at reconcile time.',
    body: `The \`forEach\` directive in an RGD resource block creates one resource per item in a list.
When you created this dungeon with 3 monsters, kro evaluated \`lists.range(size(schema.spec.monsterHP))\` to get [0, 1, 2] and created three Monster CRs automatically. Change \`monsters: 5\` and kro would create five.

The loop variable is a named key in the forEach item map (here \`idx\`). Inside the template, \`idx\` holds the current index value.`,
    snippet: `# dungeon-graph — forEach creates one Monster CR per monsterHP entry
resources:
  - id: monsterCRs
    forEach:
      - idx: >-
          \${has(schema.spec.monsterHP)
            ? lists.range(size(schema.spec.monsterHP))
            : []}
    template:
      apiVersion: game.k8s.example/v1alpha1
      kind: Monster
      metadata:
        name: \${schema.metadata.name + '-monster-' + string(idx)}
        namespace: \${schema.metadata.namespace}
      spec:
        hp: \${schema.spec.monsterHP[idx]}
        dungeonName: \${schema.metadata.name}`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — monsterCRs resource block',
  },

  'includeWhen': {
    id: 'includeWhen',
    title: 'includeWhen — Conditional Resources',
    tagline: 'Resources that only exist when a condition is true.',
    body: `\`includeWhen\` is a CEL expression on a resource block. When it evaluates to \`false\`, kro does not create (or deletes) that resource. When it flips to \`true\`, kro creates it.
This is how loot works: the Loot CR only appears when a monster's HP reaches 0. The moment you killed that monster, kro evaluated \`schema.spec.hp == 0\` and created the Loot CR, which trigger loot-graph to generate the item.`,
    snippet: `# monster-graph — lootCR only created on kill
resources:
  - id: lootCR
    includeWhen:
      - "\${schema.spec.hp == 0}"
    template:
      apiVersion: game.k8s.example/v1alpha1
      kind: Loot
      metadata:
        name: \${schema.metadata.name + '-loot'}
      spec:
        # ... item type/rarity via random.seededString()

# treasure-graph — Secret only exists when treasure is opened
  - id: treasureSecret
    includeWhen:
      - "\${schema.spec.opened == 1}"
    template:
      kind: Secret`,
    learnMore: 'manifests/rgds/monster-graph.yaml and treasure-graph.yaml',
  },

  'readyWhen': {
    id: 'readyWhen',
    title: 'readyWhen — Resource Readiness Gates',
    tagline: 'kro waits for dependencies before proceeding.',
    body: `\`readyWhen\` is a condition on a resource reference. kro will not consider a resource ready until all \`readyWhen\` conditions resolve to true. This prevents stale or incomplete state from propagating through the graph.
The dungeon modifier works this way: dungeon-graph declares a \`readyWhen\` on the modifierCR that waits until modifier-graph has finished computing the modifier type. modifier-graph itself declares its \`modifierState\` ConfigMap ready only after the type field is populated.`,
    snippet: `# dungeon-graph — readyWhen gates on modifierCR being ready
resources:
  - id: modifierCR
    includeWhen:
      - "\${schema.spec.modifier != 'none'}"
    readyWhen:
      - "\${modifierCR.status.?modifierType.orValue('') != ''}"
    template:
      # ... Modifier CR

# modifier-graph — ConfigMap declares itself ready
resources:
  - id: modifierState
    readyWhen:
      - "\${modifierState.data.modifierType != ''}"
    template:
      kind: ConfigMap
      data:
        modifierType: "\${schema.spec.modifierType}"`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml and modifier-graph.yaml',
  },

  'status-aggregation': {
    id: 'status-aggregation',
    title: 'Status Aggregation Across a Resource Graph',
    tagline: 'Parent status = .filter() across all child CR statuses.',
    body: `dungeon-graph's \`livingMonsters\` status field uses CEL's \`.filter()\` on the entire \`monsterCRs\` array (which was created by forEach). It counts how many Monster CRs have \`entityState == 'alive'\`.
This is pure declarative aggregation: no controller loop, no explicit watch — kro re-evaluates this CEL on every reconcile.`,
    snippet: `# dungeon-graph status — aggregate across all Monster CRs
status:
  livingMonsters: >-
    \${size(monsterCRs.filter(m,
      m.status.?entityState.orValue('alive') == 'alive'))}
  # Safe navigation (?.) guards against not-yet-ready child CRs
  # orValue('alive') defaults to 'alive' while Monster CR initializes`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — status.livingMonsters',
  },

  'seeded-random': {
    id: 'seeded-random',
    title: 'random.seededString() — Deterministic Randomness',
    tagline: 'kro extends CEL with seeded random for reproducible results.',
    body: `kro ships a CEL extension function \`random.seededString(length, seed)\` that generates a deterministic string from a seed using SHA-256. The same seed always produces the same output — making loot drops reproducible and auditable from the CR spec alone.

Loot type and rarity are pre-rolled at monster spawn using the dungeon name and monster index as the seed. When the monster dies, kro creates the Loot CR with the pre-determined item — and the Go backend computes the same name using the identical SHA-256 algorithm, so they always agree.`,
    snippet: `# monster-graph — loot type pre-rolled at spawn
spec:
  itemType: >-
    \${
      ['weapon','armor','hppotion','manapotion','shield','helmet','pants','boots'][
        int('abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(
          random.seededString(1, schema.spec.dungeonName + '-m' + string(schema.spec.index) + '-typ')
        ) % 8)
      ]
    }
  dropped: >-
    \${
      int('abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(
        random.seededString(1, schema.spec.dungeonName + '-m' + string(schema.spec.index) + '-drop')
      ) % 36) < (schema.spec.difficulty == 'easy' ? 22 : schema.spec.difficulty == 'hard' ? 13 : 16)
    }`,
    learnMore: 'manifests/rgds/monster-graph.yaml — lootCR spec',
  },

  'secret-output': {
    id: 'secret-output',
    title: 'Kubernetes Secret as a Computed RGD Output',
    tagline: 'RGDs can produce any resource type — including Secrets.',
    body: `kro RGDs are not limited to ConfigMaps. The loot-graph RGD creates a Kubernetes Secret to store item data — the item type, rarity, and description are all computed by CEL and stored in Secret.stringData.
Similarly, treasure-graph creates a Secret (conditionally, via includeWhen) that holds the dungeon key. This demonstrates that kro can manage any Kubernetes resource, not just CRDs.`,
    snippet: `# loot-graph — Kubernetes Secret as output
resources:
  - id: lootSecret
    template:
      apiVersion: v1
      kind: Secret
      metadata:
        name: \${schema.metadata.name}
        labels:
          game.k8s.example/item-type: \${schema.spec.itemType}
          game.k8s.example/rarity: \${schema.spec.rarity}
      stringData:
        description: >-
          \${schema.spec.itemType == 'weapon'
            ? 'A ' + schema.spec.rarity + ' weapon (+' + string(schema.spec.stat) + ' damage)'
            : schema.spec.itemType == 'armor'
              ? 'A ' + schema.spec.rarity + ' armor (+' + string(schema.spec.stat) + '% defense)'
              : '...'}`,
    learnMore: 'manifests/rgds/loot-graph.yaml and treasure-graph.yaml',
  },

  'empty-rgd': {
    id: 'empty-rgd',
    title: 'Empty RGD — CRD Factory Pattern',
    tagline: 'An RGD with resources:[] creates a CRD with no managed children.',
    body: `attack-graph and action-graph have \`resources: []\` — they manage no child resources at all. Their sole purpose is to define the Attack and Action custom resource types (CRDs).
This is the "CRD factory" pattern: use kro to get a typed, validated CRD for free, without writing a controller. The actual logic lives in dungeon-graph's specPatch nodes (CEL expressions that fire on spec changes) and in the Go backend.`,
    snippet: `# attack-graph — empty RGD, defines Attack CRD only
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: attack-graph
spec:
  schema:
    apiVersion: game.k8s.example/v1alpha1
    kind: Attack
    group: game.k8s.example
    spec:
      dungeonName: string | required=true
      target: string | required=true
      damage: integer | default=0
      seq: integer | default=0
  resources: []   # <-- no managed children, no status`,
    learnMore: 'manifests/rgds/attack-graph.yaml and action-graph.yaml',
  },

  'externalRef': {
    id: 'externalRef',
    title: 'externalRef — Watch External CRs to Trigger Reconcile',
    tagline: 'kro can watch CRs it does not own and re-reconcile when they change.',
    body: `Every time you attack, the backend creates an Attack CR (defined by the empty attack-graph RGD). The backend then also patches the Dungeon CR spec — incrementing \`attackSeq\` and setting \`lastAttackTarget\`. This spec change triggers dungeon-graph to reconcile immediately, firing the \`combatResolve\` specPatch node which computes all damage and HP mutations via CEL.

\`externalRef\` is a kro feature that lets an RGD watch CRs it doesn't own. Once registered, any change to the watched CR triggers a full reconcile — the same watch → CEL eval → write cycle. It's a powerful pattern for multi-owner resource graphs.`,
    snippet: `# dungeon-graph — specPatch fires when attackSeq advances
# Backend writes attackSeq + lastAttackTarget → triggers reconcile
- id: combatResolve
  type: specPatch
  includeWhen:
    - "\${schema.spec.attackSeq > schema.spec.combatProcessedSeq
        && schema.spec.lastAttackTarget != ''}"
  patch:
    monsterHP: "\${...CEL computes new HP array...}"
    bossHP:    "\${...CEL computes new boss HP...}"
    lastAttackTarget: ""
    combatProcessedSeq: "\${schema.spec.attackSeq}"

# externalRef pattern (watch any CR from another RGD):
resources:
  - id: attackCR
    type: externalRef
    apiVersion: game.k8s.example/v1alpha1
    kind: Attack
    name: "\${schema.metadata.name + '-latest-attack'}"`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — combatResolve specPatch node',
  },

  'status-conditions': {
    id: 'status-conditions',
    title: 'status.conditions — kro Health Signalling',
    tagline: 'kro uses status.conditions to report whether your resource graph is Ready or has Errors.',
    body: `Every kro-managed CR gets a \`status.conditions\` array automatically. kro writes two condition types:
- \`type: Ready\` — the resource graph is fully reconciled and all readyWhen checks passed
- \`type: Error\` — kro hit a problem (CEL evaluation error, missing dependency, webhook timeout)

This is the same mechanism Kubernetes uses for Pods (\`PodReady\`, \`ContainersReady\`) and Deployments (\`Available\`, \`Progressing\`). kro follows the same contract. You can inspect your dungeon's conditions directly: \`kubectl get dungeon <name> -o yaml\`.`,
    snippet: `# kubectl get dungeon <name> -o yaml
status:
  conditions:
    - type: Ready
      status: "True"
      reason: ReconcileSucceeded
      message: All resources reconciled
    - type: Error
      status: "False"
      reason: CELEvaluationFailed
      message: "cel: no such attribute: schema.spec.missingField"
  # All other status fields are your CEL expressions:
  bossState: ready
  livingMonsters: "2"`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — status block',
  },

  'reconcile-loop': {
    id: 'reconcile-loop',
    title: 'The kro Reconcile Loop',
    tagline: 'Every action triggers a watch → eval → write cycle. The ~1s pause IS kro working.',
    body: `After every attack or action, the game waits ~1 second before showing results. That pause is the kro reconcile loop:

1. **Watch** — kro's controller detects the Dungeon CR spec changed (attackSeq incremented)
2. **CEL eval** — dungeon-graph re-evaluates all CEL expressions: dice rolls, HP calculations, loot includeWhen checks
3. **spec write** — kro's combatResolve specPatch writes new HP values directly to \`spec.monsterHP\`, \`spec.bossHP\`
4. **Backend read** — the Go backend polls the Dungeon CR until attackSeq in spec matches, then reads the updated spec
5. **Frontend update** — the React app receives the updated CR and re-renders

This is standard Kubernetes controller-reconciler pattern. Every controller in your cluster does the same loop — Deployments, StatefulSets, HPA — just for different resource types.`,
    snippet: `# The poll loop in the Go backend
for {
  cr, _ := client.Get(ctx, dungeonName)
  if cr.Spec.AttackSeq > prevSeq {
    // kro has reconciled — read updated spec fields
    break
  }
  time.Sleep(500 * time.Millisecond)
}`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — combatResolve specPatch node',
  },

  'resourceGroup-api': {
    id: 'resourceGroup-api',
    title: 'ResourceGroup API — How kro Registers New CRDs',
    tagline: 'kro reads your RGD and installs a brand-new Kubernetes API group — instantly.',
    body: `When you created the Dungeon, kro did something powerful: it read \`dungeon-graph\` and called the Kubernetes API aggregation layer to register \`game.k8s.example/v1alpha1\` as a first-class Kubernetes API.

That means \`kubectl get dungeon\` works exactly like \`kubectl get pod\` — because kro made Dungeon a real Kubernetes resource, with its own OpenAPI schema, validation, and RBAC.

This is kro's "ResourceGroup API" pattern:
1. You write an RGD YAML with \`spec.schema.apiVersion\` and \`spec.schema.kind\`
2. kro registers a CRD for that group/version/kind
3. Kubernetes' API server now serves your custom resource natively
4. Any controller, tool, or GitOps agent can use \`kubectl get/apply/watch dungeon\` immediately

No code. No webhook boilerplate. Just an RGD.`,
    snippet: `# dungeon-graph.yaml — the schema block tells kro to register the CRD
spec:
  schema:
    apiVersion: game.k8s.example/v1alpha1
    kind: Dungeon
    spec:
      monsters: integer | default=3
      difficulty: string | default=normal
      heroClass: string | default=warrior

# After kro processes this:
$ kubectl api-resources | grep game.k8s.example
dungeons    game.k8s.example/v1alpha1    true    Dungeon`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — spec.schema block',
  },

  'cel-has-macro': {
    id: 'cel-has-macro',
    title: 'CEL has() — Safe Optional Field Access',
    tagline: 'Check if a field exists before reading it — the Kubernetes-native way.',
    body: `In Kubernetes CEL expressions, fields are often optional. Reading \`self.spec.modifier\` when modifier is unset throws an evaluation error. The \`has()\` macro lets you guard safely:

\`\`\`
has(self.spec.modifier) ? self.spec.modifier : "none"
\`\`\`

kro uses the equivalent \`?.orValue()\` syntax (from the CEL optional types extension):

\`\`\`
self.spec.?modifier.orValue("none")
\`\`\`

Both patterns appear throughout the dungeon-graph RGD — in \`readyWhen\` conditions, status expressions, and \`includeWhen\` guards. This is the same pattern used in Kubernetes \`ValidatingAdmissionPolicy\` and \`CRD validation rules\`.

When to use each:
- **\`has()\`** — existence check only (returns bool)
- **\`?.orValue()\`** — existence check + default value (returns the field or a default)`,
    snippet: `# In dungeon-graph.yaml — readyWhen on modifierCR
readyWhen:
  - "\${modifierCR.status.?modifierType.orValue('') != ''}"

# Equivalent CEL using has():
# has(modifierCR.status.modifierType) && modifierCR.status.modifierType != ''

# In ValidatingAdmissionPolicy (same pattern, different context):
# has(object.spec.tolerations) && object.spec.tolerations.exists(t, t.key == "gpu")`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — modifierCR readyWhen block',
  },

  'ownerReferences': {
    id: 'ownerReferences',
    title: 'ownerReferences & Garbage Collection',
    tagline: 'Deleting the Dungeon CR cascades to all 9 child resources automatically.',
    body: `When kro creates child resources (Hero CR, Monster CRs, Boss CR, ConfigMaps, Secrets, Namespace), it sets an \`ownerReferences\` field on each one pointing back to the parent Dungeon CR.

When you deleted this dungeon, Kubernetes' built-in garbage collector saw the owner was gone and automatically deleted every child — no custom cleanup logic needed. This is how Kubernetes implements cascading deletion, and kro gets it for free.`,
    snippet: `# Every child resource kro creates has this block:
metadata:
  ownerReferences:
  - apiVersion: game.k8s.example/v1alpha1
    kind: Dungeon
    name: my-dungeon
    uid: "abc-123..."
    controller: true
    blockOwnerDeletion: true
# → delete the Dungeon CR → K8s GC deletes all children`,
    learnMore: 'kubectl get hero,cm,secret -n default -o yaml | grep -A5 ownerReferences',
  },

  'spec-mutation': {
    id: 'spec-mutation',
    title: 'Spec Mutation Triggers Full Reconcile',
    tagline: 'One patch to spec → kro reconciles the entire resource graph.',
    body: `When you enter Room 2, the Go backend calls the Kubernetes API to patch the Dungeon CR spec with \`lastAction: 'enter-room-2'\` and increments \`actionSeq\`. kro watches the Dungeon CR and immediately re-evaluates all CEL expressions in dungeon-graph.
kro's \`enterRoom2Resolve\` specPatch node detects the action and computes the new \`monsterHP\`, \`bossHP\`, \`room2MonsterHP\`, \`room2BossHP\` values via CEL — writing them back to \`spec.*\` directly. New Monster CRs and an updated Boss CR are then created from those spec values. Kubernetes becomes the state machine.`,
    snippet: `# Backend writes only the trigger — kro does the rest
patch := map[string]interface{}{
  "spec": map[string]interface{}{
    "lastAction": "enter-room-2",
    "actionSeq":  newSeq,
    // kro's enterRoom2Resolve specPatch computes new HP values via CEL
  },
}
// manifests/rgds/dungeon-graph.yaml reacts automatically`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — enterRoom2Resolve specPatch node',
  },

  'cel-playground': {
    id: 'cel-playground',
    title: 'CEL Playground — Live Expression Sandbox',
    tagline: 'Type any CEL expression and evaluate it against your live dungeon spec — the same way kro evaluates RGD expressions during reconcile.',
    body: `The CEL Playground sends your expression to the backend, which evaluates it using the exact same CEL environment that kro uses during reconcile — imported directly from the kro fork running in this cluster.

Under the hood: \`POST /api/v1/dungeons/{ns}/{name}/cel-eval\` with \`{"expr":"..."}\`. The backend reads the live Dungeon spec, binds it as \`schema.spec.*\` (matching kro's RGD variable layout), and evaluates via \`cel.NewEnv(krocel.BaseDeclarations()...)\`.

This means every kro extension is available in the Playground:
- \`cel.bind(x, schema.spec.heroHP, x * 2)\` — bind macro (same as dungeon-graph.yaml)
- \`random.seededInt(0, 20, "seed")\` — deterministic random (same RNG kro uses)
- \`csv.add(schema.spec.inventory, "sword", 5)\` — CSV item manipulation
- \`lists.set([1, 2, 3], 0, 99)\` — list mutation
- \`schema.spec.heroClass.startsWith("war")\` — string functions

Try expressions that mirror real kro RGD patterns:
- \`schema.spec.heroHP > 100\` → \`true\` or \`false\`
- \`schema.spec.difficulty == "hard" ? "big dice" : "small dice"\`
- \`cel.bind(hp, schema.spec.heroHP, hp > 100 ? "healthy" : "injured")\`
- \`schema.spec.heroClass == "mage" && schema.spec.heroMana > 0\`

This is how you become fluent in CEL: not by reading docs, but by experimenting against real data. The dungeon-graph RGD has 40+ CEL expressions using these exact functions.`,
    snippet: `# In kro RGDs, expressions appear inside \${...} blocks:
status:
  bossState: >-
    \${schema.spec.bossHP > 0
      ? (schema.spec.livingMonsters == 0 ? 'ready' : 'pending')
      : 'defeated'}

# In the Playground you type the inner expression directly.
# All kro extensions are available, including cel.bind():
cel.bind(alive, schema.spec.livingMonsters > 0,
  cel.bind(bossReady, schema.spec.bossHP > 0 && !alive,
    bossReady ? "ready" : (alive ? "pending" : "defeated")
  )
)

# Result: "pending", "ready", or "defeated"`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — any CEL expression in the status block',
  },

  'cel-filter': {
    id: 'cel-filter',
    title: 'CEL Collection Macros — filter, map, exists, all',
    tagline: 'CEL iterates Kubernetes lists natively: no loops, no scripts.',
    body: `CEL includes powerful collection macros that let kro iterate over resource lists directly inside an RGD expression.

In Krombat, every time a monster dies, \`dungeon-graph\` runs this expression to update \`livingMonsters\`:

\`\`\`
monsterCRs.filter(m, m.status.?entityState.orValue('alive') == 'alive').size()
\`\`\`

This walks every Monster CR, picks the ones whose \`entityState\` is still "alive", and counts them — in a single CEL line, without any controller code. The \`?.orValue()\` guard handles Monster CRs that haven't finished initializing yet.

The four core macros are:
- \`list.filter(x, predicate)\` — keep items where predicate is true
- \`list.map(x, expr)\` — transform each item
- \`list.exists(x, predicate)\` — true if any item matches
- \`list.all(x, predicate)\` — true if all items match

kro evaluates these macros against live Kubernetes objects during every reconcile cycle.`,
    snippet: `# dungeon-graph.yaml — livingMonsters aggregation
status:
  livingMonsters: >-
    \${size(monsterCRs.filter(m,
        m.status.?entityState.orValue('alive') == 'alive'
      ))}
  # ?.orValue('alive') guards against not-yet-ready Monster CRs
  # entityState is set by monster-graph CEL: hp > 0 ? 'alive' : 'dead'`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml (status.livingMonsters) and monster-graph.yaml (entityState)',
  },

  'cel-string-ops': {
    id: 'cel-string-ops',
    title: 'CEL Type Coercion & String Ops',
    tagline: 'CEL is strictly typed — int(), string(), and + do the work.',
    body: `CEL is a strongly-typed language. Unlike JavaScript, you cannot concatenate a number and a string without an explicit cast. This matters a lot in kro RGDs, where spec fields are often integers that need to become strings for labels or ConfigMap data (and vice versa).

In Krombat, loot seeds are built by concatenating the dungeon name (a string) with the monster index (an integer), requiring an explicit \`string()\` cast:

\`\`\`
schema.spec.dungeonName + '-m' + string(schema.spec.index) + '-typ'
\`\`\`

The result is passed directly to \`random.seededString()\` — no base-36 conversion needed, because the seed is just a stable unique string.

Other common patterns in the RGDs:
- \`string(schema.spec.hp)\` — coerce int to string for ConfigMap data values
- \`string(schema.spec.stat)\` — int stat stored as string in Secret.stringData
- \`"Dungeon: " + schema.spec.name\` — string concatenation (both sides must be string)`,
    snippet: `# monster-graph.yaml — seed built from string concat
spec:
  itemType: >-
    \${
      ['weapon','armor','hppotion',...][
        int('abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(
          random.seededString(1,
            schema.spec.dungeonName + '-m' + string(schema.spec.index) + '-typ'
          )
        ) % 8)
      ]
    }

# loot-graph.yaml — int coerced to string for Secret data
stringData:
  stat: "\${string(schema.spec.stat)}"
  description: "\${'A ' + schema.spec.rarity + ' weapon (+' + string(schema.spec.stat) + ' dmg)'}"`,
    learnMore: 'manifests/rgds/monster-graph.yaml (itemType) and loot-graph.yaml (stringData)',
  },

  // #450: specPatch concept — central kro mechanism driving 9 of 16 dungeon-graph nodes
  'spec-patch': {
    id: 'spec-patch',
    title: 'specPatch — CEL State Machine',
    tagline: 'kro writes computed values back into the same CR it is watching',
    body: `\`type: specPatch\` is an RGD resource entry that evaluates a CEL expression and writes the result directly to \`spec.*\` fields on the parent CR. This triggers another reconcile loop iteration — enabling stateful game logic (combat, cooldowns, DoT, room transitions) with no backend code.

9 of dungeon-graph's 16 resource entries are specPatch nodes: \`dungeonInit\`, \`abilityResolve\`, \`tickDoT\`, \`advanceTaunt\`, \`tickCooldown\`, \`regenRing\`, \`combatResolve\`, \`actionResolve\`, \`enterRoom2Resolve\`. Together they implement the entire game engine via CEL — the Go backend only patches trigger fields (\`attackSeq\`, \`lastAbility\`, etc.) and reads the results.`,
    snippet: `# dungeon-graph.yaml — tickDoT specPatch
# Fires each attack turn when DoT is active.
# Reads spec.poisonTurns/burnTurns → writes heroHP, decrements counters.
- id: tickDoT
  type: specPatch
  includeWhen:
    - "\${schema.spec.poisonTurns > 0 || schema.spec.burnTurns > 0}"
  patch:
    heroHP: "\${schema.spec.heroHP
      - (schema.spec.poisonTurns > 0 ? 5 : 0)
      - (schema.spec.burnTurns > 0 ? 8 : 0) < 0 ? 0
      : schema.spec.heroHP - (schema.spec.poisonTurns > 0 ? 5 : 0)
      - (schema.spec.burnTurns > 0 ? 8 : 0)}"
    poisonTurns: "\${schema.spec.poisonTurns > 0 ? schema.spec.poisonTurns - 1 : 0}"
    burnTurns:   "\${schema.spec.burnTurns > 0   ? schema.spec.burnTurns - 1   : 0}"`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — all 9 specPatch nodes',
  },
}
// ─── end KRO_CONCEPTS ────────────────────────────────────────────────────────

/** Map game events to insight triggers */
export function getInsightForEvent(event: string): InsightTrigger | null {
  if (event === 'dungeon-created') return { conceptId: 'rgd', headline: 'kro built a full resource graph from your one Dungeon CR — 16 managed entries' }
  if (event === 'spec-schema') return { conceptId: 'spec-schema', headline: 'kro validated your difficulty/heroClass fields against spec.schema enums' }
  if (event === 'schema-validated') return { conceptId: 'schema-validation', headline: 'kro compiled your spec.schema into a CRD — the API server now rejects invalid dungeons' }
  if (event === 'resource-chaining') return { conceptId: 'resource-chaining', headline: 'Hero CR status (maxHP, class) flowed up through dungeon-graph resource chaining' }
   if (event === 'first-attack') return { conceptId: 'cel-basics', headline: 'Your damage was computed by a CEL expression in the combatResolve specPatch node' }
  if (event === 'monster-killed') return { conceptId: 'includeWhen', headline: 'A Loot CR appeared because monster HP hit 0 (includeWhen)' }
  if (event === 'boss-ready') return { conceptId: 'cel-ternary', headline: 'Boss transitioned pending → ready via a CEL ternary in boss-graph' }
  if (event === 'boss-killed') return { conceptId: 'cel-filter', headline: 'kro ran .filter() on all Monster CRs to re-aggregate livingMonsters to 0' }
  if (event === 'all-monsters-dead') return { conceptId: 'status-aggregation', headline: 'All monsters dead — kro aggregated victory state from Hero + Boss + Monster CRs' }
  if (event === 'treasure-opened') return { conceptId: 'secret-output', headline: 'Opening treasure created a Kubernetes Secret via treasure-graph' }
  if (event === 'enter-room-2') return { conceptId: 'spec-mutation', headline: 'One spec patch triggered a full kro reconcile of the resource graph' }
  if (event === 'modifier-present') return { conceptId: 'readyWhen', headline: 'dungeon-graph waited for modifier-graph via readyWhen before proceeding' }
  if (event === 'forEach') return { conceptId: 'forEach', headline: 'kro created one Monster CR per entry in monsterHP[] via forEach' }
  if (event === 'loot-drop') return { conceptId: 'seeded-random', headline: 'Loot type and rarity rolled via random.seededString() in monster-graph' }
  if (event === 'loot-drop-string-ops') return { conceptId: 'cel-string-ops', headline: 'Loot seed = dungeonName + \'-m\' + string(index) — string() converts int index to string for seed concatenation' }
  if (event === 'attack-cr') return { conceptId: 'empty-rgd', headline: 'Attack CR is defined by an RGD with resources:[] — a CRD factory' }
  if (event === 'externalRef') return { conceptId: 'externalRef', headline: 'Your attack created an Attack CR — kro watched it and re-reconciled the dungeon graph' }
  if (event === 'status-conditions') return { conceptId: 'status-conditions', headline: 'kro is reporting its reconcile status via status.conditions — the Kubernetes health contract' }
  if (event === 'second-attack') return { conceptId: 'reconcile-loop', headline: 'The ~1s pause after every action is the kro reconcile loop: watch → CEL eval → write' }
  if (event === 'third-attack') return { conceptId: 'spec-patch', headline: 'combatResolve fired a specPatch — CEL wrote hero HP, monster HP, and combat seq directly into spec' }
  if (event === 'dungeon-created-2nd') return { conceptId: 'resourceGroup-api', headline: 'kro registered Dungeon as a real Kubernetes API — kubectl get dungeon works natively' }
   if (event === 'boots-equipped') return { conceptId: 'cel-has-macro', headline: 'has() lets CEL safely access optional spec fields — used throughout dungeon-graph readyWhen' }
  if (event === 'dungeon-deleted') return { conceptId: 'ownerReferences', headline: 'Deleting the Dungeon CR triggered cascading deletion of all 9 child resources via ownerReferences' }
  if (event === 'cel-playground-unlocked') return { conceptId: 'cel-playground', headline: 'Open the CEL Playground to write and evaluate live kro expressions against your dungeon' }
  // #450: spec-patch concept fires on first DoT tick — most visible specPatch in action
  if (event === 'dot-applied') return { conceptId: 'spec-patch', headline: 'tickDoT specPatch fired: CEL decremented heroHP and poisonTurns/burnTurns directly in spec' }
  return null
}

// ─── InsightCard Component ────────────────────────────────────────────────────

interface InsightCardProps {
  trigger: InsightTrigger
  onDismiss: () => void
  onViewConcept: (id: KroConceptId) => void
}

export function InsightCard({ trigger, onDismiss, onViewConcept }: InsightCardProps) {
  const concept = KRO_CONCEPTS[trigger.conceptId]
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // slide in
    const t1 = setTimeout(() => setVisible(true), 50)
    // auto-dismiss after 12s
    const t2 = setTimeout(() => { setVisible(false); setTimeout(onDismiss, 350) }, 12000)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [trigger.conceptId])

  const handleDismiss = () => {
    setVisible(false)
    setTimeout(onDismiss, 350)
  }

  return (
    <div className={`kro-insight-card${visible ? ' visible' : ''}`} role="complementary" aria-label="kro insight">
      <div className="kro-insight-header">
        <span className="kro-insight-badge">kro</span>
        <span className="kro-insight-headline">{trigger.headline}</span>
        <button className="kro-insight-dismiss" onClick={handleDismiss} aria-label="Dismiss insight">✕</button>
      </div>
      <div className="kro-insight-title">{concept.title}</div>
      <div className="kro-insight-tagline">{concept.tagline}</div>
      <button className="kro-insight-learn" onClick={() => { onViewConcept(trigger.conceptId); handleDismiss() }}>
        Learn more →
      </button>
    </div>
  )
}

// ─── KroConceptModal ─────────────────────────────────────────────────────────

interface KroConceptModalProps {
  conceptId: KroConceptId
  onClose: () => void
}

export function KroConceptModal({ conceptId, onClose }: KroConceptModalProps) {
  const concept = KRO_CONCEPTS[conceptId]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal kro-concept-modal" role="dialog" aria-modal="true" aria-label={`kro concept: ${concept.title}`}
        onClick={e => e.stopPropagation()} style={{ maxWidth: 560, textAlign: 'left' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <span className="kro-insight-badge" style={{ fontSize: 8, marginBottom: 4, display: 'inline-block' }}>kro concept</span>
            <h2 style={{ color: 'var(--gold)', fontSize: 12, margin: 0 }}>{concept.title}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close concept">✕</button>
        </div>
        <p style={{ fontSize: 8, color: '#ccc', marginBottom: 12, lineHeight: 1.6 }}>{concept.body}</p>
        <div className="kro-snippet-block">
          <div className="kro-snippet-label">YAML / CEL</div>
          <pre className="yaml-view kro-snippet-pre">{concept.snippet}</pre>
        </div>
        <div style={{ fontSize: 7, color: '#666', marginTop: 8 }}>
          See: <span style={{ color: '#5dade2' }}>{concept.learnMore}</span>
        </div>
        <button className="btn btn-gold" style={{ marginTop: 12 }} onClick={onClose}>Got it</button>
      </div>
    </div>
  )
}

// ─── KroGlossary Component ────────────────────────────────────────────────────

const STORAGE_KEY = 'kroUnlockedConcepts'

export function useKroGlossary() {
  const [unlocked, setUnlocked] = useState<Set<KroConceptId>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) return new Set(JSON.parse(stored) as KroConceptId[])
    } catch { /* ignore */ }
    return new Set()
  })

  const unlock = useCallback((id: KroConceptId) => {
    setUnlocked(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [])

  return { unlocked, unlock }
}

const CONCEPT_ORDER: KroConceptId[] = [
  'rgd', 'spec-schema', 'schema-validation', 'resource-chaining', 'cel-basics', 'cel-ternary',
  'forEach', 'includeWhen', 'readyWhen', 'status-aggregation',
  'seeded-random', 'secret-output', 'empty-rgd', 'spec-mutation',
  'externalRef', 'status-conditions', 'reconcile-loop',
  'resourceGroup-api', 'cel-has-macro', 'ownerReferences', 'cel-playground',
  'cel-filter', 'cel-string-ops', 'spec-patch',
]

interface KroGlossaryProps {
  unlocked: Set<KroConceptId>
  onViewConcept: (id: KroConceptId) => void
}

export function KroGlossary({ unlocked, onViewConcept }: KroGlossaryProps) {
  const total = CONCEPT_ORDER.length
  const count = unlocked.size
  const [search, setSearch] = useState('')

  const filtered = CONCEPT_ORDER.filter(id => {
    if (!search) return true
    const c = KRO_CONCEPTS[id]
    const q = search.toLowerCase()
    return c.title.toLowerCase().includes(q) || c.tagline.toLowerCase().includes(q)
  })

  return (
    <div className="kro-glossary">
      <div className="kro-glossary-header">
        <span className="kro-insight-badge">kro</span>
        <span style={{ fontSize: 8, color: '#ccc', marginLeft: 6 }}>Concepts discovered:</span>
        <span style={{ fontSize: 8, color: 'var(--gold)', marginLeft: 4 }}>{count} / {total}</span>
        {count === total && <span style={{ fontSize: 7, color: '#2ecc71', marginLeft: 6 }}>kro expert!</span>}
      </div>
      {count >= 4 && (
        <div className="kro-glossary-search">
          <input
            className="kro-glossary-search-input"
            type="text"
            placeholder="filter concepts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="kro-glossary-search-clear" onClick={() => setSearch('')}>×</button>
          )}
        </div>
      )}
      <div className="kro-glossary-grid">
        {filtered.map(id => {
          const c = KRO_CONCEPTS[id]
          const isUnlocked = unlocked.has(id)
          return (
            <button
              key={id}
              className={`kro-glossary-item${isUnlocked ? ' unlocked' : ' locked'}`}
              onClick={() => isUnlocked && onViewConcept(id)}
              disabled={!isUnlocked}
              title={isUnlocked ? c.title : 'Keep playing to unlock'}
              aria-label={isUnlocked ? `kro concept: ${c.title}` : 'Locked concept'}
            >
              <div className="kro-glossary-item-title">{isUnlocked ? c.title : '???'}</div>
              {isUnlocked && <div className="kro-glossary-item-tagline">{c.tagline}</div>}
              {!isUnlocked && <div className="kro-glossary-item-tagline" style={{ color: '#444' }}>Keep playing to unlock</div>}
            </button>
          )
        })}
      </div>
      {search && filtered.length === 0 && (
        <div className="kro-glossary-empty">no concepts match "{search}"</div>
      )}
      {count === 0 && (
        <div style={{ fontSize: 7, color: '#555', textAlign: 'center', padding: '16px 0' }}>
          Start playing to discover kro concepts in action.
        </div>
      )}
    </div>
  )
}

// ─── K8s Log Annotations ─────────────────────────────────────────────────────

export interface KroAnnotation {
  what: string     // what happened in kro terms
  rgd: string      // which RGD handles this
  cel?: string     // relevant CEL expression snippet
  concept: KroConceptId
}

/** Given a K8s log command + yaml string, return a kro annotation */
export function kroAnnotate(cmd: string, yaml: string): KroAnnotation | null {
  if (cmd.includes('kubectl apply') && yaml.includes('kind: Dungeon')) {
    return {
      what: 'kro reads dungeon-graph RGD and creates: Namespace, Hero CR, Monster CRs (forEach), Boss CR, Treasure CR, Modifier CR, gameConfig ConfigMap, and up to 8 specPatch nodes that act as the game engine.',
      rgd: 'dungeon-graph',
      cel: `forEach:
  - idx: "\${lists.range(size(schema.spec.monsterHP))}"
# Creates one Monster CR per monsterHP entry`,
      concept: 'rgd',
    }
  }
  if (cmd.includes('kubectl apply') && yaml.includes('kind: Attack')) {
    return {
      what: 'kro sees the Attack CR (defined by the empty attack-graph RGD). The backend also patches attackSeq + lastAttackTarget on the Dungeon CR, triggering dungeon-graph to reconcile and fire the combatResolve specPatch node — computing new HP values in CEL.',
      rgd: 'attack-graph (empty RGD) + dungeon-graph (combatResolve specPatch)',
      cel: `# dungeon-graph combatResolve specPatch
- id: combatResolve
  type: specPatch
  includeWhen:
    - "\${attackSeq > combatProcessedSeq && lastAttackTarget != ''}"
  patch:
    monsterHP: "\${...CEL computes new HP array...}"`,
      concept: 'cel-basics',
    }
  }
  if (cmd.includes('kubectl apply') && yaml.includes('kind: Action') && yaml.includes('equip')) {
    return {
      what: 'kro sees the Action CR (defined by the empty action-graph RGD). The backend also patches actionSeq + lastAction on the Dungeon CR, triggering dungeon-graph to reconcile and fire the actionResolve specPatch node — computing new equip bonuses via CEL.',
      rgd: 'action-graph (empty RGD) + dungeon-graph (actionResolve specPatch)',
      cel: `# dungeon-graph actionResolve specPatch
- id: actionResolve
  type: specPatch
  patch:
    weaponBonus: "\${a == 'equip-weapon-common' ? 5
      : a == 'equip-weapon-rare' ? 10
      : a == 'equip-weapon-epic' ? 20
      : schema.spec.weaponBonus}"`,
      concept: 'empty-rgd',
    }
  }
  if (cmd.includes('kubectl apply') && yaml.includes('kind: Action') && yaml.includes('use-')) {
    return {
      what: 'Item use is also an Action CR. The actionResolve specPatch in dungeon-graph computes the new heroHP after applying the potion and writes it back to spec.',
      rgd: 'action-graph (empty RGD) + dungeon-graph (actionResolve specPatch)',
      cel: `# actionResolve specPatch — HP potion CEL
heroHP: "\${cel.bind(a, schema.spec.lastAction,
  cel.bind(hp, schema.spec.heroHP,
  cel.bind(maxHP, ...,
    a == 'use-hppotion-common' ? (hp + 20 > maxHP ? maxHP : hp + 20)
    : a == 'use-hppotion-rare'  ? (hp + 40 > maxHP ? maxHP : hp + 40)
    : a == 'use-hppotion-epic'  ? maxHP
    : hp
  ))}"`,
      concept: 'empty-rgd',
    }
  }
  if (cmd.includes('kubectl get dungeon')) {
    return {
      what: 'After reconcile, dungeon-graph has re-aggregated all child CR statuses into this Dungeon CR status. livingMonsters is a .filter() over all Monster CR statuses.',
      rgd: 'dungeon-graph (status aggregation)',
      cel: `status:
  livingMonsters: "\${size(monsterCRs.filter(m,
    m.status.?entityState.orValue('alive') == 'alive'))}"
  bossState: "\${bossCR.status.entityState}"`,
      concept: 'status-aggregation',
    }
  }
  return null
}

// ─── Status Bar kro Tooltips ─────────────────────────────────────────────────

export const KRO_STATUS_TIPS = {
  livingMonsters: `kro field: status.livingMonsters
Computed by dungeon-graph via:
  size(monsterCRs.filter(m,
    m.status.?entityState.orValue('alive') == 'alive'))
Each monster-graph RGD updates its entityState ConfigMap when HP changes.`,

  bossState: `kro field: status.bossState → bossCR.status.entityState
boss-graph CEL ternary:
  hp > 0
    ? (monstersAlive == 0 ? 'ready' : 'pending')
    : 'defeated'
Three states, zero controller code.`,

  difficulty: `kro field: spec.difficulty
Validated by dungeon-graph spec.schema:
  difficulty: string | default="normal" enum=easy,normal,hard
kro rejects invalid values at admission time.`,

  room: `kro field: spec.currentRoom
Patched by the backend when you enter Room 2.
One spec patch triggers full dungeon-graph reconciliation:
  new Monster CRs, new Boss CR, updated ConfigMaps.`,

  turn: `kro field: spec.attackSeq
Monotonically incrementing counter.
The backend uses this for optimistic concurrency control:
  reject attack if attackSeq in request != current attackSeq.`,
}

// ─── CelTrace — shows live CEL execution context after a combat round ────────

export interface CelTraceData {
  formula: string       // e.g. "2d12+6"
  difficulty: string
  heroClass: string
  heroAction: string    // from spec.lastHeroAction
  combatLog: string     // from spec.lastCombatLog (JSON)
  modifier?: string     // e.g. "curse-darkness", "blessing-strength"
  helmetBonus?: number  // crit chance %
  pantsBonus?: number   // dodge chance %
  bossHP?: number       // current boss HP (>0 means fighting boss)
  maxBossHP?: number    // boss max HP for phase % calculation
}

/**
 * CelTrace renders a collapsible "What kro computed" panel inside the
 * combat modal resolved phase. It reconstructs the CEL context from
 * the dungeon spec and shows which expressions fired.
 */
export function CelTrace({ data, onLearnMore }: { data: CelTraceData; onLearnMore: () => void }) {
  const [open, setOpen] = useState(false)

  // Parse combat log JSON if available
  let log: Record<string, any> = {}
  try { log = JSON.parse(data.combatLog || '{}') } catch { /* ignore */ }

  // Reconstruct readable CEL expressions
  const celLines: { expr: string; result: string; note?: string }[] = []

  celLines.push({
    expr: `schema.spec.difficulty == '${data.difficulty}'`,
    result: 'true',
    note: 'selects dice formula',
  })
  celLines.push({
    expr: `diceFormula`,
    result: `"${data.formula}"`,
    note: 'from gameConfig ConfigMap',
  })
  // Always show seeded-random row — even on first attack when combatLog is empty
  celLines.push({
    expr: `random.seededString(lastCombatLog, alphabet, 8)`,
    result: `"${(data.combatLog || '(new-seed)').slice(0, 8)}..."`,
    note: 'seeded → deterministic roll',
  })
  if (log.weaponBonus > 0) {
    celLines.push({
      expr: `schema.spec.weaponBonus`,
      result: `${log.weaponBonus}`,
      note: `+${log.weaponBonus} damage applied`,
    })
  }
  if (log.armorBonus > 0) {
    celLines.push({
      expr: `schema.spec.armorBonus`,
      result: `${log.armorBonus}%`,
      note: 'counter-attack reduced',
    })
  }

  // Modifier branch — show ternary with resolved multiplier
  if (data.modifier && data.modifier !== 'none') {
    let modExpr = ''
    let modResult = ''
    let modNote = ''
    if (data.modifier === 'curse-darkness') {
      // #447: correct CEL uses schema.spec.modifier (not spec.modifier)
      modExpr = `schema.spec.modifier == 'curse-darkness' ? classMult * 3 / 4 : classMult`
      modResult = '× 0.75'
      modNote = 'Curse of Darkness: hero deals 25% less damage'
    } else if (data.modifier === 'blessing-strength') {
      // #447: actual multiplier is 3/2 = 1.5 (not 1.25)
      modExpr = `schema.spec.modifier == 'blessing-strength' ? classMult * 3 / 2 : classMult`
      modResult = '× 1.5'
      modNote = 'Blessing of Strength: hero deals 50% more damage'
    } else if (data.modifier === 'blessing-fortune') {
      // #447: actual mechanic is 20% crit → 2× damage (not flat 1.15)
      modExpr = `random.seededInt(0, 100, s+'-crit') < 20 ? classMult * 2 : classMult`
      modResult = '20% crit → × 2.0'
      modNote = 'Blessing of Fortune: 20% chance to deal 2× damage'
    } else if (data.modifier === 'curse-fury') {
      // #447: actual multiplier is phased * 2 = 2.0× boss counter (not 1.25)
      modExpr = `schema.spec.modifier == 'curse-fury' ? phased * 2 : phased`
      modResult = '× 2.0 (boss counter doubled)'
      modNote = 'Curse of Fury: boss counter-attack doubled'
    } else if (data.modifier === 'curse-fortitude') {
      // #447: does NOT affect counter-attack — increases monster spawn HP by 50%
      modExpr = `# dungeonInit: mod == 'curse-fortitude' ? base * 3 / 2 : base`
      modResult = '× 1.5 HP at spawn'
      modNote = 'Curse of Fortitude: monsters spawn with 50% more HP (applied at dungeon creation)'
    } else if (data.modifier === 'blessing-resilience') {
      // #447: actual multiplier is phased / 2 = 0.5× counter (not 0.85)
      modExpr = `schema.spec.modifier == 'blessing-resilience' ? phased / 2 : phased`
      modResult = '× 0.5 (counter halved)'
      modNote = 'Blessing of Resilience: counter-attack halved'
    }
    if (modExpr) {
      celLines.push({ expr: modExpr, result: modResult, note: modNote })
    }
  }

  // Helmet — critical hit chance
  if ((data.helmetBonus ?? 0) > 0) {
    const critFired = data.heroAction.includes('CRIT') || data.heroAction.includes('Critical')
    celLines.push({
      // #446: correct function is random.seededInt(0, N, seed); seed var is s = schema.spec.lastAttackSeed
      expr: `random.seededInt(0, 100, s + '-helmet-crit') < schema.spec.helmetBonus`,
      result: critFired ? 'true → 2x damage' : 'false',
      note: `${data.helmetBonus}% crit chance (helmet)`,
    })
  }

  // Pants — dodge chance
  if ((data.pantsBonus ?? 0) > 0) {
    const dodgeFired = data.heroAction.includes('dodged') || data.heroAction.includes('Pants dodge')
    celLines.push({
      // #446: correct function is random.seededInt(0, N, seed); seed var is s = schema.spec.lastAttackSeed
      expr: `random.seededInt(0, 100, s + '-pants-dodge') < schema.spec.pantsBonus`,
      result: dodgeFired ? 'true → counter = 0' : 'false',
      note: `${data.pantsBonus}% extra dodge (pants)`,
    })
  }

  if (data.heroClass === 'mage') {
    celLines.push({
      expr: `schema.spec.heroClass == 'mage' ? 1.3 : 1.0`,
      result: '1.3',
      note: 'mage 1.3x damage multiplier',
    })
  }
  if (data.heroClass === 'warrior') {
    celLines.push({
      expr: `schema.spec.heroClass == 'warrior' ? 0.75 : 1.0`,
      result: '0.75',
      note: '25% counter-attack reduction',
    })
  }

  // Extract damage dealt from heroAction
  const dmgMatch = data.heroAction.match(/deals (\d+) damage/)
  if (dmgMatch) {
    celLines.push({
      expr: `finalDamage`,
      result: dmgMatch[1],
      note: 'written to spec.monsterHP[i]',
    })
  }

  // Stun: hero skipped attack this turn
  if (data.heroAction.includes('STUNNED')) {
    celLines.push({
      expr: `schema.spec.stunTurns > 0`,
      result: 'true',
      note: 'hero stunned — attack skipped, stunTurns decremented',
    })
  }

  // Rogue dodge
  if (data.heroAction.includes('dodged') || data.heroAction.includes('Rogue dodged')) {
    celLines.push({
      // #446: correct function is random.seededInt(0, N, seed + suffix)
      expr: `schema.spec.heroClass == 'rogue' && random.seededInt(0, 100, s + '-dodge-monster') < 25`,
      result: 'true',
      note: '25% dodge chance — counter-attack negated',
    })
  }

  // Backstab
  if (data.heroAction.includes('Backstab') || data.heroAction.includes('backstab')) {
    celLines.push({
      // #446: trigger field is schema.spec.lastAttackIsBackstab (not backstabCooldown == 0)
      expr: `schema.spec.lastAttackIsBackstab ? baseDmg * 3 : baseDmg`,
      result: dmgMatch ? String(Number(dmgMatch[1])) : '3x',
      note: 'Backstab: 3× damage, sets cooldown=3',
    })
  }

  // Boss phase — show CEL ternary when fighting boss
  if ((data.bossHP ?? 0) > 0 && (data.maxBossHP ?? 0) > 0) {
    const pct = Math.round(((data.bossHP!) / (data.maxBossHP!)) * 100)
    // #446: actual boss-graph uses integer arithmetic (×100 / maxHP), outputs 'phase1'/'phase2'/'phase3'
    // damageMultiplier stored as integer ×10: phase1=10 (1.0×), phase2=13 (1.3×), phase3=16 (1.6×)
    const phase = pct <= 25 ? 'phase3' : pct <= 50 ? 'phase2' : 'phase1'
    const phaseResult = phase === 'phase3' ? '"phase3" (1.6× dmg)' : phase === 'phase2' ? '"phase2" (1.3× dmg)' : '"phase1" (1.0× dmg)'
    celLines.push({
      expr: `hp * 100 / maxHP > 50 ? 'phase1' : hp * 100 / maxHP > 25 ? 'phase2' : 'phase3'`,
      result: phaseResult,
      note: `boss at ${pct}% HP → ${phase}`,
    })
  }

  return (
    <div className="cel-trace">
      <button className="cel-trace-toggle" onClick={() => setOpen(o => !o)}>
        <span className="kro-insight-badge" style={{ fontSize: 6 }}>kro</span>
        <span style={{ flex: 1, textAlign: 'left', marginLeft: 6, fontSize: 7, color: '#888' }}>
          What CEL computed {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <div className="cel-trace-body">
          <div className="cel-trace-header">dungeon-graph → combatResolve specPatch <span style={{ fontSize: 10, color: '#888', marginLeft: 6 }}>post-reconcile state</span></div>
          <table className="cel-trace-table">
            <thead>
              <tr>
                <th>CEL expression</th>
                <th>value</th>
                <th>note</th>
              </tr>
            </thead>
            <tbody>
              {celLines.map((l, i) => (
                <tr key={i}>
                  <td className="cel-trace-expr">{l.expr}</td>
                  <td className="cel-trace-val">{l.result}</td>
                  <td className="cel-trace-note">{l.note || ''}</td>
                </tr>
              ))}
             </tbody>
          </table>
          <button className="k8s-annotation-learn" onClick={onLearnMore} style={{ marginTop: 4 }}>
            Learn: cel-basics →
          </button>
        </div>
      )}
    </div>
  )
}

// ─── kro Expert Certificate ──────────────────────────────────────────────────

export interface KroExpertCertificateProps {
  dungeonName: string
  heroClass: string
  difficulty: string
  turns: number
  unlocked: Set<KroConceptId>
  onClose: () => void
}

export function KroExpertCertificate({ dungeonName, heroClass, difficulty, turns, unlocked, onClose }: KroExpertCertificateProps) {
  const total = CONCEPT_ORDER.length
  const count = unlocked.size
  const isMaster = count === total
  const title = isMaster ? 'kro Master' : count >= 9 ? 'kro Expert' : count >= 4 ? 'kro Practitioner' : 'kro Apprentice'
  return (
    <div className="kro-cert-overlay" onClick={onClose}>
      <div className="kro-cert-modal" onClick={e => e.stopPropagation()}>
        <div className="kro-cert-header">
          <div className="kro-cert-badge"><PixelIcon name={isMaster ? 'crown' : 'star'} size={32} /></div>
          <div className="kro-cert-title">{title}</div>
          <div className="kro-cert-subtitle">Certificate of Completion</div>
        </div>

        <div className="kro-cert-body">
          <div className="kro-cert-field"><span className="kro-cert-label">Dungeon</span><span className="kro-cert-value">{dungeonName}</span></div>
          <div className="kro-cert-field"><span className="kro-cert-label">Hero</span><span className="kro-cert-value">{heroClass} · {difficulty}</span></div>
          <div className="kro-cert-field"><span className="kro-cert-label">Turns</span><span className="kro-cert-value">{turns}</span></div>
          <div className="kro-cert-field"><span className="kro-cert-label">kro Concepts</span><span className="kro-cert-value" style={{ color: isMaster ? '#f5c518' : '#4ade80' }}>{count}/{total}</span></div>
        </div>

        <div className="kro-cert-concepts">
          <div className="kro-cert-section-title">Concepts Mastered</div>
          <div className="kro-cert-concept-grid">
            {CONCEPT_ORDER.map(id => {
              const c = KRO_CONCEPTS[id]
              const done = unlocked.has(id)
              return (
                <div key={id} className={`kro-cert-concept ${done ? 'done' : 'locked'}`}>
                  <span className="kro-cert-concept-check">{done ? '✓' : '○'}</span>
                  <span className="kro-cert-concept-name">{c.title.split('(')[0].trim()}</span>
                </div>
              )
            })}
          </div>
        </div>

        {!isMaster && (
          <div className="kro-cert-hint">
            Play again to unlock all {total} concepts and earn <strong>kro Master</strong>!
          </div>
        )}

        <div className="kro-cert-actions">
          <button className="btn btn-primary" onClick={onClose} style={{ fontSize: 8 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── First-Run Onboarding Overlay ────────────────────────────────────────────

const ONBOARDING_SLIDES = [
  {
    title: 'Your Dungeon is a Kubernetes CR',
    body: 'When you create a dungeon, the frontend runs:\nkubectl apply -f dungeon.yaml\nYou are about to apply a real Custom Resource to a live EKS cluster.',
    snippet: `apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: my-dungeon
spec:
  monsters: 3
  difficulty: normal
  heroClass: warrior`,
  },
  {
    title: 'kro Creates 16 Resources From One CR',
    // #451: updated from "7 resources + 2 ConfigMaps" to reflect current architecture
    body: "kro's dungeon-graph RGD watches your Dungeon CR. The moment you apply it, kro automatically creates a Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, 1 GameConfig CM, and 9 specPatch nodes (combatResolve, actionResolve, etc.) that write CEL-computed values directly back to spec — all from a single CR.",
    snippet: `# dungeon-graph RGD orchestrates:
resources:
  - id: ns           # Namespace
  - id: heroCR       # Hero CR → hero-graph
  - id: monsterCRs   # Monster CR ×N (forEach)
  - id: bossCR       # Boss CR → boss-graph
  - id: treasureCR   # Treasure CR → treasure-graph
  - id: gameConfig   # ConfigMap (1 ConfigMap)
  - id: combatResolve  # specPatch (CEL combat engine → writes spec.*)
  - id: actionResolve  # specPatch (equip/use/room logic → writes spec.*)`,
  },
  {
    title: 'Every Action Triggers a kro Reconcile',
    // #451: remove "backend runs kubectl patch" — the backend uses the Go K8s API client
    body: 'When you attack, equip an item, or open a door, the Go backend calls the Kubernetes API to patch the Dungeon CR spec (attackSeq, lastAction, etc.). kro watches the change and re-reconciles the entire resource graph within ~1 second — running all CEL specPatch nodes.',
    snippet: `# Attack → backend patches Dungeon CR via Go K8s API
// The kubectl commands shown in the K8s log tab are
// simulated for teaching — the actual mechanism is:
client.Resource(dungeonGVR).Namespace(ns).Patch(ctx,
  name, types.MergePatchType,
  []byte(\`{"spec": {"attackSeq": N, "lastAttackTarget": "boss"}}\`),
  metav1.PatchOptions{})
# kro re-evaluates all CEL → writes to spec.* via specPatch`,
  },
  {
    title: 'Watch the kro Tab as You Play',
    // #451: "15 concepts" → 23 concepts; "9 more" → "17 more"
    body: "Open the kro tab in the event log to see concepts unlock in real time. Each game event maps to a kro pattern. By the end of the dungeon, you'll have seen 23 core kro concepts in action.",
    snippet: `# Concepts you'll unlock:
✓ ResourceGraphDefinition (RGD)
✓ spec.schema validation
✓ forEach fan-out
✓ includeWhen conditional resources
✓ CEL expressions
✓ specPatch — CEL writes back to spec
  ... and 17 more`,
  },
  {
    title: 'kubectl Terminal Mode',
    body: "Inside any dungeon, open ☰ → kubectl Terminal for a real CLI experience. Type kubectl commands — they call the actual backend API. Every command shows a [kro] annotation explaining which RGD fired and which CEL expression ran.",
    snippet: `$ kubectl get dungeons
NAME           HERO-CLASS  DIFFICULTY  HP    BOSS-HP  ROOM
my-dungeon     warrior     normal      163   400      1

$ kubectl describe dungeon my-dungeon
Spec:
  heroHP: 163  difficulty: normal
  bossHP: 400  currentRoom: 1

[kro] What just happened? ▼
  RGD: dungeon-graph (read)
  CEL: status.bossPhase = bossHP <= maxBossHP*0.5 ? "phase2" : "phase1"`,
  },
  {
    title: 'Share Your Run',
    body: "When you win, a shareable Run Card is auto-generated — an SVG image showing your hero, difficulty, turn count, and kro concepts unlocked. Click ↗ Share Run on the victory screen to copy a tweet-ready text + card URL to your clipboard. Every win is a kro awareness moment.",
    snippet: `# The card is served as a plain SVG by the backend:
GET /api/v1/run-card/<ns>/<dungeon-name>?concepts=N

# No image hosting needed. The URL is shareable as-is.
# Every card footer links back to learn-kro.eks.aws.dev`,
  },
  {
    title: 'Running a Demo? We have a script.',
    body: "Planning to show kro at a meetup, KubeCon booth, or lightning talk? A complete 5-minute rehearsable demo script is in the repo — no local setup needed, runs entirely from this browser. Includes speaker notes with answers to the 10 most common kro questions.",
    snippet: `# Docs/demo/DEMO.md — 5-minute live demo script
# Docs/demo/dungeon-demo.yaml — the YAML shown on stage
# Docs/demo/speaker-notes.md — Q&A cheat sheet (10+ scenarios)

# To open the demo script:
# github.com/pnz1990/krombat/blob/main/Docs/demo/DEMO.md`,
  },
]

export function KroOnboardingOverlay({ onDismiss, isAuthenticated }: { onDismiss: () => void; isAuthenticated: boolean }) {
  const [slide, setSlide] = useState(0)
  const total = ONBOARDING_SLIDES.length
  const s = ONBOARDING_SLIDES[slide]
  const isLast = slide === total - 1

  const handleDismiss = () => {
    // #478: only persist dismissal for authenticated users — unauthenticated users
    // always see the tour on page load so conference/demo visitors can always learn
    if (isAuthenticated) localStorage.setItem('kroOnboardingDone', '1')
    onDismiss()
  }

  return (
    <div className="kro-onboard-overlay">
      <div className="kro-onboard-modal">
        <div className="kro-onboard-header">
          <span className="kro-insight-badge">kro</span>
          <span className="kro-onboard-step">{slide + 1} / {total}</span>
        </div>
        <div className="kro-onboard-title">{s.title}</div>
        <div className="kro-onboard-body">{s.body}</div>
        <pre className="kro-onboard-snippet">{s.snippet}</pre>
        <div className="kro-onboard-actions">
          {slide > 0 && (
            <button className="btn" onClick={() => setSlide(slide - 1)} style={{ fontSize: 8 }}>← Back</button>
          )}
          <div style={{ flex: 1 }} />
          {isLast ? (
            <button className="btn btn-primary" onClick={handleDismiss} style={{ fontSize: 8 }}>Start Playing →</button>
          ) : (
            <button className="btn btn-primary" onClick={() => setSlide(slide + 1)} style={{ fontSize: 8 }}>Next →</button>
          )}
        </div>
        <button className="kro-onboard-skip" onClick={handleDismiss}>Skip intro</button>
      </div>
    </div>
  )
}

// ─── CEL Playground ──────────────────────────────────────────────────────────

const CEL_EXAMPLES = [
  { label: 'Hero HP check', expr: 'schema.spec.heroHP > 100' },
  { label: 'Difficulty branch', expr: 'schema.spec.difficulty == "hard" ? "big dice" : "small dice"' },
  { label: 'Mage mana', expr: 'schema.spec.heroClass == "mage" && schema.spec.heroMana > 0' },
  // #453: schema.spec.monsterHP.all(...) — correct check for all-monsters-dead (schema.spec.monsters is immutable count, not current state)
  { label: 'Boss state ternary', expr: 'schema.spec.bossHP > 0 ? (schema.spec.monsterHP.all(hp, hp <= 0) ? "ready" : "pending") : "defeated"' },
  { label: 'Damage × 1.3 (mage)', expr: 'schema.spec.heroClass == "mage" ? schema.spec.heroHP * 13 / 10 : schema.spec.heroHP' },
  // #453: self → schema (kro binds root as 'schema', not 'self')
  { label: 'Optional field', expr: 'schema.spec.?modifier.orValue("none")' },
  { label: 'String concat', expr: 'string(schema.spec.heroHP) + " / " + string(schema.spec.monsters)' },
  { label: 'Room 2 check', expr: 'schema.spec.currentRoom == 2' },
]

export interface KroCelPlaygroundProps {
  dungeonNs: string
  dungeonName: string
  onLearnConcept: (id: KroConceptId) => void
  onClose: () => void
}

export function KroCelPlayground({ dungeonNs, dungeonName, onLearnConcept, onClose }: KroCelPlaygroundProps) {
  const [expr, setExpr] = useState('schema.spec.heroHP > 100')
  const [result, setResult] = useState<string | null>(null)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<{ expr: string; result: string; isErr: boolean }[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const runEval = async (expression?: string) => {
    const e = (expression ?? expr).trim()
    if (!e) return
    setLoading(true)
    setResult(null)
    setEvalError(null)
    try {
      const r = await fetch(`/api/v1/dungeons/${dungeonNs}/${dungeonName}/cel-eval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expr: e }),
      })
      const data = await r.json()
      if (data.error) {
        setEvalError(data.error)
        setHistory(h => [{ expr: e, result: data.error, isErr: true }, ...h].slice(0, 20))
      } else {
        setResult(data.result)
        setHistory(h => [{ expr: e, result: data.result, isErr: false }, ...h].slice(0, 20))
      }
    } catch (err) {
      setEvalError('Network error — is the backend reachable?')
    } finally {
      setLoading(false)
    }
  }

  const handleExample = (e: string) => {
    setExpr(e)
    setResult(null)
    setEvalError(null)
    inputRef.current?.focus()
  }

  const handleKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault()
      runEval()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal kro-playground-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="CEL Playground">
        {/* Header */}
        <div className="kro-playground-header">
          <span className="kro-insight-badge">kro</span>
          <span className="kro-playground-title">CEL Playground</span>
          <span className="kro-playground-subtitle">Evaluate expressions against live dungeon spec</span>
          <button className="modal-close" onClick={onClose} aria-label="Close playground">✕</button>
        </div>

        {/* Bindings context */}
        <div className="kro-playground-context">
          <span className="kro-playground-context-label">dungeon:</span>
          <span className="kro-playground-context-value">{dungeonNs}/{dungeonName}</span>
          <span className="kro-playground-context-hint"> — spec fields are live from Kubernetes</span>
        </div>

        <div className="kro-playground-body">
          {/* Left: editor + examples */}
          <div className="kro-playground-left">
            <div className="kro-playground-editor-label">
              Expression <span className="kro-playground-hint">Ctrl+Enter to run</span>
              {/* #453: show character counter against 500-char backend limit */}
              <span style={{ marginLeft: 'auto', fontSize: 9, color: expr.length > 450 ? '#e74c3c' : '#888' }}>
                {expr.length}/500
              </span>
            </div>
            <textarea
              ref={inputRef}
              className="kro-playground-input"
              value={expr}
              onChange={e => setExpr(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
              spellCheck={false}
              aria-label="CEL expression input"
              placeholder="schema.spec.heroHP > 100"
            />
            <button
              className="btn btn-primary kro-playground-run"
              onClick={() => runEval()}
              disabled={loading || !expr.trim()}
              aria-label="Evaluate expression"
            >
              {loading ? 'Evaluating...' : '▶ Run'}
            </button>

            {/* Result */}
            {(result !== null || evalError !== null) && (
              <div className={`kro-playground-result ${evalError ? 'kro-playground-result-err' : 'kro-playground-result-ok'}`}
                aria-label="evaluation result">
                <span className="kro-playground-result-label">{evalError ? 'error' : 'result'}</span>
                <span className="kro-playground-result-val">{evalError ?? result}</span>
              </div>
            )}

            {/* Examples */}
            <div className="kro-playground-examples-label">Examples</div>
            <div className="kro-playground-examples">
              {CEL_EXAMPLES.map(ex => (
                <button key={ex.label} className="kro-playground-example-btn"
                  onClick={() => handleExample(ex.expr)}
                  title={ex.expr}>
                  {ex.label}
                </button>
              ))}
            </div>
          </div>

          {/* Right: history */}
          <div className="kro-playground-right">
            <div className="kro-playground-history-label">History</div>
            {history.length === 0 && (
              <div className="kro-playground-history-empty">Run an expression to see results here</div>
            )}
            <div className="kro-playground-history">
              {history.map((h, i) => (
                <div key={i} className={`kro-playground-history-item${h.isErr ? ' kro-playground-history-err' : ''}`}
                  onClick={() => { setExpr(h.expr); setResult(null); setEvalError(null) }}
                  title="Click to restore" role="button" tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && setExpr(h.expr)}>
                  <div className="kro-playground-history-expr">{h.expr}</div>
                  <div className="kro-playground-history-result">{h.result}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="kro-playground-footer">
          <button className="k8s-annotation-learn" onClick={() => onLearnConcept('cel-playground')}>
            Learn: CEL Playground concept →
          </button>
          <div style={{ flex: 1 }} />
          <div className="kro-playground-supported">
            {/* #453: list all kro CEL extensions registered in BaseDeclarations() */}
            Supported: field access · arithmetic · ternary · string() · int() · size() · has() · cel.bind() · random.seededInt/String() · lists.set/range/filter() · csv.add/remove() · maps.* · 500 char limit
          </div>
        </div>
      </div>
    </div>
  )
}
