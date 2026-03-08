/**
 * KroTeach — in-game kro teaching layer
 *
 * Components:
 *  - InsightCard      : slide-in contextual card triggered by game events
 *  - KroGlossary      : progressive concept glossary (fills in as player triggers concepts)
 *  - kroAnnotate()    : returns kro commentary + CEL snippets for a K8s log entry
 *  - KRO_STATUS_TIPS  : per-field tooltip copy for the status bar
 */

import { useState, useEffect, useCallback } from 'react'

// ─── Types ──────────────────────────────────────────────────────────────────

export type KroConceptId =
  | 'rgd'
  | 'spec-schema'
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
    tagline: 'One CR. Seven resources. Zero imperative code.',
    body: `A ResourceGraphDefinition is a kro custom resource that describes a graph of Kubernetes resources.
When you applied the Dungeon CR, kro read the dungeon-graph RGD and automatically created a Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, and two ConfigMaps — all from a single \`kubectl apply\`.`,
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
      forEach: lists.range(size(schema.spec.monsterHP))
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

  'resource-chaining': {
    id: 'resource-chaining',
    title: 'Resource Chaining',
    tagline: 'Child CR status flows back to parent status automatically.',
    body: `dungeon-graph creates a Hero CR. The Hero CR is handled by hero-graph, which creates a heroState ConfigMap. dungeon-graph's status block reads from that ConfigMap (via \`${'{'}heroCR.status.maxHP{'}'}\`) and exposes it as the dungeon's own status.
This is resource chaining: each RGD handles one layer, and kro wires the outputs together.`,
    snippet: `# dungeon-graph status — reading from child CRs
status:
  maxHeroHP: \${heroCR.status.maxHP}
  livingMonsters: >-
    \${size(monsterCRs.filter(m,
      m.status.?entityState.orValue('alive') == 'alive'))}
  bossState: \${bossCR.status.entityState}
  treasureState: \${treasureCR.status.treasureState}`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — status block',
  },

  'cel-basics': {
    id: 'cel-basics',
    title: 'CEL — Common Expression Language',
    tagline: 'All game logic is pure CEL inside YAML. No controllers.',
    body: `CEL (Common Expression Language) is the expression engine kro uses inside \${...} blocks. Every dice roll, HP transition, and state change in this game is a CEL expression evaluated at reconcile time — no custom controllers, no Go code for game logic.
The damage you just dealt was computed by a CEL expression in the combatResult ConfigMap.`,
    snippet: `# dungeon-graph — combatResult ConfigMap (damage computation)
# CEL evaluates on every reconcile triggered by an Attack CR
data:
  diceRoll: >-
    \${string(int(random.seededString(schema.spec.lastCombatLog,
      'abcdefghijklmnopqrstuvwxyz0123456789', 8), 36) % 20 + 1)}
  heroBaseDmg: >-
    \${schema.spec.difficulty == 'easy'
      ? string(int(diceRoll) + 2)
      : schema.spec.difficulty == 'hard'
        ? string(int(diceRoll) * 3 + 5)
        : string(int(diceRoll) * 2 + 4)}`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — combatResult ConfigMap',
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
When you created this dungeon with 3 monsters, kro evaluated \`lists.range(size(schema.spec.monsterHP))\` to get [0, 1, 2] and created three Monster CRs automatically. Change \`monsters: 5\` and kro would create five.`,
    snippet: `# dungeon-graph — forEach creates one Monster CR per monsterHP entry
resources:
  - id: monsterCRs
    forEach: lists.range(size(schema.spec.monsterHP))
    template:
      apiVersion: game.k8s.example/v1alpha1
      kind: Monster
      metadata:
        name: \${schema.metadata.name + '-monster-' + string(item)}
        namespace: \${schema.metadata.namespace}
      spec:
        hp: \${schema.spec.monsterHP[item]}
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
    body: `\`readyWhen\` is a condition on a resource or on a reference to a child CR. kro will not consider the parent resource ready until all \`readyWhen\` conditions on its children resolve to true.
The dungeon modifier works this way: dungeon-graph has a \`readyWhen\` on the modifierCR that waits until modifier-graph has finished computing the modifier type. This prevents the dungeon from reporting a wrong state before the modifier is ready.`,
    snippet: `# dungeon-graph — readyWhen gates on modifierCR
resources:
  - id: modifierCR
    includeWhen:
      - "\${schema.spec.modifier != 'none'}"
    readyWhen:
      - "\${self.status.?modifierType.orValue('') != ''}"
    template:
      # ... Modifier CR

# modifier-graph — resource declares itself ready
resources:
  - id: modifierState
    readyWhen:
      - "self.data.modifierType != ''"
    template:
      kind: ConfigMap`,
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
    body: `kro ships a CEL extension function \`random.seededString(seed, alphabet, length)\` that generates a deterministic pseudo-random string from a seed.
Dice rolls in this game use the lastCombatLog field as a seed — so the same attack submitted twice with the same combat log produces the same "random" number. This makes the game reproducible and auditable from the CR spec alone.`,
    snippet: `# dungeon-graph — dice roll via random.seededString
data:
  diceRoll: >-
    \${string(
      int(random.seededString(
        schema.spec.lastCombatLog,   # seed (changes every attack)
        'abcdefghijklmnopqrstuvwxyz0123456789',
        8                            # length of random string
      ), 36) % 20 + 1               # base-36 → mod → dice value
    )}`,
    learnMore: 'manifests/rgds/dungeon-graph.yaml — combatResult ConfigMap',
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
            ? 'A ' + schema.spec.rarity + ' weapon (+' + string(schema.spec.statValue) + ' damage)'
            : schema.spec.itemType == 'armor'
              ? 'A ' + schema.spec.rarity + ' armor (+' + string(schema.spec.statValue) + '% defense)'
              : '...'}`,
    learnMore: 'manifests/rgds/loot-graph.yaml and treasure-graph.yaml',
  },

  'empty-rgd': {
    id: 'empty-rgd',
    title: 'Empty RGD — CRD Factory Pattern',
    tagline: 'An RGD with resources:[] creates a CRD with no managed children.',
    body: `attack-graph and action-graph have \`resources: []\` — they manage no child resources at all. Their sole purpose is to define the Attack and Action custom resource types (CRDs).
This is the "CRD factory" pattern: use kro to get a typed, validated CRD for free, without writing a controller. The actual logic lives in dungeon-graph's ConfigMaps (CEL expressions) and in the Go backend.`,
    snippet: `# attack-graph — empty RGD, defines Attack CRD only
apiVersion: kro.run/v1alpha1
kind: ResourceGraphDefinition
metadata:
  name: attack-graph
spec:
  schema:
    apiVersion: game.k8s.example/v1alpha1
    kind: Attack
    spec:
      dungeonName: string | required=true
      target: string | required=true
      damage: integer | default=0
  resources: []   # <-- no managed children
  status:
    state: "ready"  # static literal, not a CEL expression`,
    learnMore: 'manifests/rgds/attack-graph.yaml and action-graph.yaml',
  },

  'spec-mutation': {
    id: 'spec-mutation',
    title: 'Spec Mutation Triggers Full Reconcile',
    tagline: 'One patch to spec → kro reconciles the entire resource graph.',
    body: `When you enter Room 2, the backend patches a single field — \`currentRoom: 2\` — on the Dungeon CR spec. kro watches the Dungeon CR and immediately re-evaluates all CEL expressions in dungeon-graph.
This causes new Monster CRs (room2MonsterHP), a new Boss CR (room2BossHP), and updated ConfigMaps to be created or updated — all from a single spec field change. Kubernetes becomes the state machine.`,
    snippet: `# Backend Go code — one PATCH drives the whole transition
patch := map[string]interface{}{
  "spec": map[string]interface{}{
    "currentRoom":    2,
    "monsterHP":      room2MonsterHP,
    "bossHP":         room2BossHP,
    "attackSeq":      newSeq,
    // kro re-evaluates ALL dungeon-graph CEL with these new values
  },
}
// manifests/rgds/dungeon-graph.yaml reacts automatically`,
    learnMore: 'backend/internal/handlers/handlers.go and dungeon-graph.yaml',
  },
}

// ─── Insight trigger mapping ──────────────────────────────────────────────────

/** Map game events to insight triggers */
export function getInsightForEvent(event: string): InsightTrigger | null {
  if (event === 'dungeon-created') return { conceptId: 'rgd', headline: 'kro created 7 resources from your one Dungeon CR' }
  if (event === 'spec-schema') return { conceptId: 'spec-schema', headline: 'kro validated your difficulty/heroClass fields against spec.schema enums' }
  if (event === 'resource-chaining') return { conceptId: 'resource-chaining', headline: 'Hero CR status (maxHP, class) flowed up through dungeon-graph resource chaining' }
  if (event === 'first-attack') return { conceptId: 'cel-basics', headline: 'Your damage was computed by a CEL expression in a ConfigMap' }
  if (event === 'monster-killed') return { conceptId: 'includeWhen', headline: 'A Loot CR appeared because monster HP hit 0 (includeWhen)' }
  if (event === 'boss-ready') return { conceptId: 'cel-ternary', headline: 'Boss transitioned pending → ready via a CEL ternary in boss-graph' }
  if (event === 'boss-killed') return { conceptId: 'status-aggregation', headline: 'Victory state aggregated from Hero + Boss + Monster CR statuses' }
  if (event === 'treasure-opened') return { conceptId: 'secret-output', headline: 'Opening treasure created a Kubernetes Secret via treasure-graph' }
  if (event === 'enter-room-2') return { conceptId: 'spec-mutation', headline: 'One spec patch triggered a full kro reconcile of the resource graph' }
  if (event === 'modifier-present') return { conceptId: 'readyWhen', headline: 'dungeon-graph waited for modifier-graph via readyWhen before proceeding' }
  if (event === 'forEach') return { conceptId: 'forEach', headline: 'kro created one Monster CR per entry in monsterHP[] via forEach' }
  if (event === 'loot-drop') return { conceptId: 'seeded-random', headline: 'Loot type and rarity rolled via random.seededString() in monster-graph' }
  if (event === 'attack-cr') return { conceptId: 'empty-rgd', headline: 'Attack CR is defined by an RGD with resources:[] — a CRD factory' }
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
  'rgd', 'spec-schema', 'resource-chaining', 'cel-basics', 'cel-ternary',
  'forEach', 'includeWhen', 'readyWhen', 'status-aggregation',
  'seeded-random', 'secret-output', 'empty-rgd', 'spec-mutation',
]

interface KroGlossaryProps {
  unlocked: Set<KroConceptId>
  onViewConcept: (id: KroConceptId) => void
}

export function KroGlossary({ unlocked, onViewConcept }: KroGlossaryProps) {
  const total = CONCEPT_ORDER.length
  const count = unlocked.size

  return (
    <div className="kro-glossary">
      <div className="kro-glossary-header">
        <span className="kro-insight-badge">kro</span>
        <span style={{ fontSize: 8, color: '#ccc', marginLeft: 6 }}>Concepts discovered:</span>
        <span style={{ fontSize: 8, color: 'var(--gold)', marginLeft: 4 }}>{count} / {total}</span>
        {count === total && <span style={{ fontSize: 7, color: '#2ecc71', marginLeft: 6 }}>kro expert!</span>}
      </div>
      <div className="kro-glossary-grid">
        {CONCEPT_ORDER.map(id => {
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
      what: 'kro reads dungeon-graph RGD and creates: Namespace, Hero CR, Monster CRs (forEach), Boss CR, Treasure CR, Modifier CR, combatResult ConfigMap, actionResult ConfigMap.',
      rgd: 'dungeon-graph',
      cel: `forEach: lists.range(size(schema.spec.monsterHP))
# Creates one Monster CR per monsterHP entry`,
      concept: 'rgd',
    }
  }
  if (cmd.includes('kubectl apply') && yaml.includes('kind: Attack')) {
    return {
      what: 'kro sees the Attack CR (via attack-graph empty RGD). dungeon-graph reconciles, re-evaluating the combatResult ConfigMap CEL to compute new HP values.',
      rgd: 'attack-graph (empty RGD) + dungeon-graph (combatResult)',
      cel: `# dungeon-graph combatResult ConfigMap
diceRoll: "\${string(int(random.seededString(
  schema.spec.lastCombatLog, 'abc...', 8), 36) % 20 + 1)}"
heroBaseDmg: "\${difficulty == 'hard' ? roll*3+5 : roll*2+4}"`,
      concept: 'cel-basics',
    }
  }
  if (cmd.includes('kubectl apply') && yaml.includes('kind: Action') && yaml.includes('equip')) {
    return {
      what: 'kro sees the Action CR (action-graph empty RGD). dungeon-graph reconciles, re-evaluating the actionResult ConfigMap to compute new weaponBonus/armorBonus/etc.',
      rgd: 'action-graph (empty RGD) + dungeon-graph (actionResult)',
      cel: `# dungeon-graph actionResult ConfigMap
weaponBonus: "\${action == 'equip-weapon-rare' ? '10'
  : action == 'equip-weapon-epic' ? '20' : '5'}"`,
      concept: 'empty-rgd',
    }
  }
  if (cmd.includes('kubectl apply') && yaml.includes('kind: Action') && yaml.includes('use-')) {
    return {
      what: 'Item use is also an Action CR. The actionResult ConfigMap CEL computes the new heroHP after applying the potion.',
      rgd: 'action-graph (empty RGD) + dungeon-graph (actionResult)',
      cel: `# actionResult — HP potion CEL
newHeroHP: "\${action == 'use-hppotion-epic'
  ? string(maxHeroHP)
  : string(min(heroHP + healAmt, maxHeroHP))}"`,
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
  if (log.seq) {
    celLines.push({
      expr: `random.seededString(lastCombatLog, alphabet, 8)`,
      result: `"${data.combatLog.slice(0, 8)}..."`,
      note: 'seeded → deterministic',
    })
  }
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
          <div className="cel-trace-header">dungeon-graph → combatResult ConfigMap</div>
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
