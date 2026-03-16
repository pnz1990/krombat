/**
 * KubectlTerminal — read-only CLI experience with real backend calls (#457)
 *
 * Read-only: get, describe, -o yaml for all 9 kro CRDs.
 * No write commands (apply, delete, patch removed — use the game UI).
 * All security: auth, ownership checks — unchanged from REST API.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { listDungeons, getDungeon, getDungeonResource, DungeonCR } from './api'

// ─── kro annotations per command ─────────────────────────────────────────────
interface KroAnnotation {
  what: string
  rgd: string
  cel?: string
  concept: string
}

function kroAnnotationForCommand(cmd: string): KroAnnotation | null {
  const c = cmd.trim().toLowerCase()
  if (c.includes('get') || c.includes('describe')) {
    return {
      what: 'kro continuously reconciles the Dungeon CR spec against the ResourceGraphDefinition schema. Every field you see was written by a kro CEL expression or by the Go backend via specPatch.',
      rgd: 'dungeon-graph (read)',
      cel: `status.bossPhase = bossHP <= maxBossHP * 0.25 ? "phase3" : bossHP <= maxBossHP * 0.5 ? "phase2" : "phase1"`,
      concept: 'reconcile-loop',
    }
  }
  return null
}

// ─── Minimal YAML serialiser for display (no dependency) ─────────────────────
function toYAML(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (obj === null || obj === undefined) return 'null'
  if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj)
  if (typeof obj === 'string') {
    // Quote strings that look like they need it
    if (/[:{}\[\],&*#?|<>=!%@`]/.test(obj) || obj.includes('\n') || obj.trim() !== obj || obj === '') {
      return JSON.stringify(obj)
    }
    return obj
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return obj.map(item => `\n${pad}- ${toYAML(item, indent + 1).replace(/^\n/, '')}`).join('')
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return entries
      .map(([k, v]) => {
        const val = toYAML(v, indent + 1)
        if (val.startsWith('\n') || (typeof v === 'object' && v !== null && !Array.isArray(v))) {
          return `\n${pad}${k}:${val.startsWith('\n') ? val : ' ' + val}`
        }
        if (Array.isArray(v) && v.length > 0) {
          return `\n${pad}${k}:${val}`
        }
        return `\n${pad}${k}: ${val}`
      })
      .join('')
  }
  return String(obj)
}

function objToYAML(obj: Record<string, unknown>): string {
  return toYAML(obj, 0).replace(/^\n/, '')
}

// ─── Output line types ────────────────────────────────────────────────────────
type LineKind = 'prompt' | 'output' | 'error' | 'kro' | 'yaml'
interface OutputLine {
  id: number
  kind: LineKind
  text: string
  annotation?: KroAnnotation
  annotationOpen?: boolean
}

// ─── Resource type registry ───────────────────────────────────────────────────
// Maps singular/plural/shorthand kubectl names to our internal kind + fetch strategy
interface ResourceSpec {
  singular: string   // canonical singular name shown in output
  plural: string     // plural form (shown in table header, 'get <plural>')
  apiVersion: string
  kind: string       // K8s Kind
  fetchKind: string  // kind param for getDungeonResource
  indexed: boolean   // requires ?index=N (monsters, loots)
  countFromSpec?: (spec: DungeonCR['spec']) => number // how many exist
}

const RESOURCE_REGISTRY: Record<string, ResourceSpec> = {
  // Dungeon (special — uses getDungeon, not getDungeonResource)
  dungeon:   { singular: 'dungeon',  plural: 'dungeons',  apiVersion: 'game.k8s.example/v1alpha1', kind: 'Dungeon',   fetchKind: 'dungeon',  indexed: false },
  dungeons:  { singular: 'dungeon',  plural: 'dungeons',  apiVersion: 'game.k8s.example/v1alpha1', kind: 'Dungeon',   fetchKind: 'dungeon',  indexed: false },

  // Hero
  hero:      { singular: 'hero',     plural: 'heroes',    apiVersion: 'game.k8s.example/v1alpha1', kind: 'Hero',      fetchKind: 'hero',     indexed: false },
  heroes:    { singular: 'hero',     plural: 'heroes',    apiVersion: 'game.k8s.example/v1alpha1', kind: 'Hero',      fetchKind: 'hero',     indexed: false },

  // Boss
  boss:      { singular: 'boss',     plural: 'bosses',    apiVersion: 'game.k8s.example/v1alpha1', kind: 'Boss',      fetchKind: 'boss',     indexed: false },
  bosses:    { singular: 'boss',     plural: 'bosses',    apiVersion: 'game.k8s.example/v1alpha1', kind: 'Boss',      fetchKind: 'boss',     indexed: false },

  // Monster
  monster:   { singular: 'monster',  plural: 'monsters',  apiVersion: 'game.k8s.example/v1alpha1', kind: 'Monster',   fetchKind: 'monster',  indexed: true,  countFromSpec: s => s.monsterHP?.length ?? 0 },
  monsters:  { singular: 'monster',  plural: 'monsters',  apiVersion: 'game.k8s.example/v1alpha1', kind: 'Monster',   fetchKind: 'monster',  indexed: true,  countFromSpec: s => s.monsterHP?.length ?? 0 },

  // Treasure
  treasure:  { singular: 'treasure', plural: 'treasures', apiVersion: 'game.k8s.example/v1alpha1', kind: 'Treasure',  fetchKind: 'treasure', indexed: false },
  treasures: { singular: 'treasure', plural: 'treasures', apiVersion: 'game.k8s.example/v1alpha1', kind: 'Treasure',  fetchKind: 'treasure', indexed: false },

  // Modifier
  modifier:  { singular: 'modifier', plural: 'modifiers', apiVersion: 'game.k8s.example/v1alpha1', kind: 'Modifier',  fetchKind: 'modifier', indexed: false },
  modifiers: { singular: 'modifier', plural: 'modifiers', apiVersion: 'game.k8s.example/v1alpha1', kind: 'Modifier',  fetchKind: 'modifier', indexed: false },

  // Loot
  loot:      { singular: 'loot',     plural: 'loots',     apiVersion: 'game.k8s.example/v1alpha1', kind: 'Loot',      fetchKind: 'loot',     indexed: true,  countFromSpec: s => s.monsterHP?.length ?? 0 },
  loots:     { singular: 'loot',     plural: 'loots',     apiVersion: 'game.k8s.example/v1alpha1', kind: 'Loot',      fetchKind: 'loot',     indexed: true,  countFromSpec: s => s.monsterHP?.length ?? 0 },
}

// ─── Command parser ───────────────────────────────────────────────────────────
interface ParsedCmd {
  verb: 'get' | 'describe' | 'cat' | 'help' | 'clear' | 'unknown'
  resourceType?: string
  resourceName?: string
  outputFormat?: 'yaml' | 'table'  // -o yaml / --output=yaml
  flags: Record<string, string>
  raw: string
}

function parseKubectl(raw: string): ParsedCmd {
  const parts = raw.trim().split(/\s+/)
  const flags: Record<string, string> = {}
  const positional: string[] = []
  let i = 0

  if (parts[0] === 'kubectl') i = 1

  const verb = (parts[i++] || 'help').toLowerCase()

  for (; i < parts.length; i++) {
    if (parts[i].startsWith('--')) {
      const [k, ...v] = parts[i].slice(2).split('=')
      flags[k] = v.join('=') || parts[++i] || ''
    } else if (parts[i] === '-o' || parts[i] === '--output') {
      flags['o'] = parts[++i] || ''
    } else if (parts[i].startsWith('-o')) {
      flags['o'] = parts[i].slice(2) || ''
    } else if (parts[i] === '-f') {
      flags['f'] = parts[++i] || ''
    } else if (!parts[i].startsWith('-')) {
      positional.push(parts[i])
    }
  }

  if (verb === 'cat') return { verb: 'cat', flags, raw }
  if (verb === 'help' || verb === '--help' || verb === '-h') return { verb: 'help', flags, raw }
  if (verb === 'clear') return { verb: 'clear', flags, raw }

  const resourceType = positional[0]?.toLowerCase()
  const resourceName = positional[1]
  const outputFormat = (flags['o'] || flags['output'] || '') === 'yaml' ? 'yaml' : 'table'

  if (!['get', 'describe'].includes(verb)) {
    return { verb: 'unknown', resourceType, resourceName, flags, raw }
  }

  return { verb: verb as ParsedCmd['verb'], resourceType, resourceName, outputFormat, flags, raw }
}

// ─── Main component ───────────────────────────────────────────────────────────
export interface KubectlTerminalProps {
  dungeonNs: string
  dungeonName: string
  dungeonCR: DungeonCR
  onClose: () => void
  onNavigateToDungeon?: (ns: string, name: string) => void
}

let lineId = 0
const nextId = () => ++lineId

const RESOURCE_TYPES = 'dungeons, heroes, monsters, bosses, treasures, modifiers, loots'

const HELP_TEXT = `Read-only kubectl terminal. Supports all kro CRDs.

  kubectl get dungeons                     List your dungeons
  kubectl get dungeon <name>               Show dungeon spec fields
  kubectl get dungeon <name> -o yaml       Full dungeon CR as YAML
  kubectl get hero <dungeon>               Hero CR for a dungeon
  kubectl get hero <dungeon> -o yaml       Full hero CR as YAML
  kubectl get monsters <dungeon>           List all monster CRs
  kubectl get monster <dungeon> <idx>      One monster CR (index 0..N)
  kubectl get monster <dungeon> <idx> -o yaml
  kubectl get boss <dungeon>               Boss CR
  kubectl get boss <dungeon> -o yaml       Full boss CR as YAML
  kubectl get treasure <dungeon>           Treasure CR
  kubectl get modifier <dungeon>           Modifier CR
  kubectl get loot <dungeon>               List loot CRs
  kubectl get loot <dungeon> <idx> -o yaml One loot CR as YAML
  kubectl describe dungeon <name>          Verbose dungeon info + kro status
  kubectl describe hero <dungeon>          Verbose hero info
  kubectl describe boss <dungeon>          Boss phases, HP, kro-derived state
  kubectl describe monster <dungeon> <idx> Monster HP + entityState
  cat dungeon.yaml                         Show dungeon YAML template
  clear                                    Clear terminal
  help                                     Show this help

Resource types: ${RESOURCE_TYPES}
Write operations (apply, delete, patch) are disabled — use the game UI.
Every command shows a [kro] annotation explaining what happened.`

export function KubectlTerminal({ dungeonNs, dungeonName, dungeonCR, onClose }: KubectlTerminalProps) {
  const [lines, setLines] = useState<OutputLine[]>([
    { id: nextId(), kind: 'output', text: `# kubectl terminal — ${dungeonName}  (read-only)` },
    { id: nextId(), kind: 'output', text: `# Type 'help' for all commands. Covers all 9 kro CRDs.` },
    { id: nextId(), kind: 'output', text: '' },
  ])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines])
  useEffect(() => { inputRef.current?.focus() }, [])

  const addLine = useCallback((kind: LineKind, text: string, annotation?: KroAnnotation) => {
    setLines(prev => [...prev, { id: nextId(), kind, text, annotation, annotationOpen: false }])
  }, [])

  const addLineWithAnn = useCallback((text: string, annotation: KroAnnotation | null) => {
    setLines(prev => [...prev, { id: nextId(), kind: 'output', text, annotation: annotation ?? undefined, annotationOpen: false }])
  }, [])

  const toggleAnnotation = useCallback((id: number) => {
    setLines(prev => prev.map(l => l.id === id ? { ...l, annotationOpen: !l.annotationOpen } : l))
  }, [])

  // ─── YAML output helper ───────────────────────────────────────────────────
  const showYAML = useCallback((obj: Record<string, unknown>, annotation: KroAnnotation | null) => {
    // Strip managedFields and noisy metadata sub-fields for readability
    const cleaned: Record<string, unknown> = { ...obj }
    if (cleaned.metadata && typeof cleaned.metadata === 'object') {
      const m = { ...(cleaned.metadata as Record<string, unknown>) }
      delete m.managedFields
      delete m.resourceVersion
      delete m.uid
      delete m.generation
      delete m.creationTimestamp
      cleaned.metadata = m
    }
    const yaml = objToYAML(cleaned)
    setLines(prev => [
      ...prev,
      { id: nextId(), kind: 'yaml', text: yaml, annotation: annotation ?? undefined, annotationOpen: false },
    ])
  }, [])

  // ─── Describe helpers ─────────────────────────────────────────────────────
  function describeFields(fields: [string, unknown][], label?: string) {
    if (label) addLine('output', `${label}:`)
    for (const [k, v] of fields) {
      if (v === undefined || v === null || v === '') continue
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
      addLine('output', `  ${k}: ${val}`)
    }
  }

  // ─── Command execution ────────────────────────────────────────────────────
  const executeCommand = useCallback(async (raw: string) => {
    if (!raw.trim()) return
    setHistory(h => [raw, ...h.slice(0, 49)])
    setHistIdx(-1)
    addLine('prompt', `$ ${raw}`)

    const cmd = parseKubectl(raw)
    const ann = kroAnnotationForCommand(raw)
    setBusy(true)

    try {
      // ── clear ──────────────────────────────────────────────────────────────
      if (cmd.verb === 'clear') { setLines([]); setBusy(false); return }

      // ── help ──────────────────────────────────────────────────────────────
      if (cmd.verb === 'help') { HELP_TEXT.split('\n').forEach(l => addLine('output', l)); setBusy(false); return }

      // ── cat dungeon.yaml ──────────────────────────────────────────────────
      if (cmd.verb === 'cat') {
        const spec = dungeonCR.spec
        const yaml = `apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: ${dungeonName}
  namespace: ${dungeonNs}
spec:
  monsters: ${spec?.monsters ?? 3}
  difficulty: ${spec?.difficulty ?? 'normal'}
  heroClass: ${spec?.heroClass ?? 'warrior'}
  # kro dungeon-graph RGD will reconcile this CR and create:
  #   Namespace, Hero CR, Monster CR ×${spec?.monsters ?? 3}, Boss CR,
  #   Treasure CR, Modifier CR, GameConfig CM, specPatch nodes`
        addLine('yaml', yaml)
        setBusy(false)
        return
      }

      // ── write commands ────────────────────────────────────────────────────
      if (cmd.verb === 'unknown') {
        const v = raw.trim().split(/\s+/)[cmd.raw.startsWith('kubectl') ? 1 : 0] ?? raw.split(' ')[0]
        if (['apply', 'create', 'delete', 'patch', 'edit', 'replace'].includes(v)) {
          addLine('error', `error: "${v}" is not supported — this terminal is read-only.`)
          addLine('output', `Use the game UI to create and manage dungeons.`)
        } else {
          addLine('error', `error: unknown command "${v}" — type 'help' to see available commands`)
        }
        setBusy(false)
        return
      }

      // ── kubectl get / describe ─────────────────────────────────────────────
      if (cmd.verb !== 'get' && cmd.verb !== 'describe') {
        addLine('error', `error: unknown verb "${cmd.verb}"`)
        setBusy(false)
        return
      }

      const rt = cmd.resourceType
      const rn = cmd.resourceName   // could be index for monsters
      const yaml = cmd.outputFormat === 'yaml'

      if (!rt) {
        addLine('error', `error: must specify the type of resource to get`)
        addLine('output', `Resource types: ${RESOURCE_TYPES}`)
        setBusy(false)
        return
      }

      const spec = RESOURCE_REGISTRY[rt]

      // ── kubectl get dungeons (list) ───────────────────────────────────────
      if ((rt === 'dungeons' || rt === 'dungeon') && !rn && cmd.verb === 'get') {
        const list = await listDungeons()
        if (list.length === 0) { addLine('output', 'No resources found.'); addLineWithAnn('', ann); setBusy(false); return }
        const header = 'NAME                          DIFFICULTY   BOSS-STATE    MONSTERS   ROOM   MOD'
        addLine('output', header)
        addLine('output', '─'.repeat(header.length))
        for (const d of list) {
          addLine('output',
            `${d.name.padEnd(30)} ${(d.difficulty ?? '?').padEnd(12)} ${(d.bossState ?? '?').padEnd(13)} ${String(d.livingMonsters ?? '?').padEnd(6)} ?      ${d.modifier ?? 'none'}`
          )
        }
        addLineWithAnn('', ann)
        setBusy(false)
        return
      }

      // ── kubectl get/describe dungeon <name> ───────────────────────────────
      if ((rt === 'dungeon' || rt === 'dungeons') && rn) {
        const d = await getDungeon(dungeonNs, rn)
        const s = d.spec || {}
        if (yaml || cmd.verb === 'get' && yaml) {
          showYAML(d as unknown as Record<string, unknown>, ann)
        } else if (cmd.verb === 'describe') {
          addLine('output', `Name:         ${d.metadata.name}`)
          addLine('output', `Namespace:    ${d.metadata.namespace}`)
          addLine('output', `APIVersion:   game.k8s.example/v1alpha1`)
          addLine('output', `Kind:         Dungeon`)
          addLine('output', '')
          describeFields([
            ['heroClass', s.heroClass], ['difficulty', s.difficulty],
            ['heroHP', s.heroHP], ['heroMana', s.heroMana],
            ['monsters', s.monsters], ['bossHP', s.bossHP],
            ['currentRoom', s.currentRoom ?? 1],
            ['modifier', s.modifier], ['inventory', s.inventory || '(empty)'],
            ['poisonTurns', s.poisonTurns], ['burnTurns', s.burnTurns], ['stunTurns', s.stunTurns],
            ['xpEarned', s.xpEarned],
          ], 'Spec')
          addLine('output', '')
          if (d.status) {
            describeFields(Object.entries(d.status), 'Status (kro-derived)')
          }
          addLineWithAnn('', ann)
        } else {
          // get (table row)
          addLine('output', 'NAME                          HERO-CLASS   DIFFICULTY   HP     BOSS-HP   ROOM')
          addLine('output',
            `${(d.metadata.name ?? '').padEnd(30)} ${(s.heroClass ?? '?').padEnd(12)} ${(s.difficulty ?? '?').padEnd(12)} ${String(s.heroHP ?? '?').padEnd(6)} ${String(s.bossHP ?? '?').padEnd(9)} ${s.currentRoom ?? 1}`
          )
          addLineWithAnn('', ann)
        }
        setBusy(false)
        return
      }

      // ── monsters list ─────────────────────────────────────────────────────
      if ((rt === 'monsters' || rt === 'monster') && !rn && cmd.verb === 'get') {
        const count = dungeonCR.spec?.monsterHP?.length ?? 0
        if (count === 0) { addLine('output', 'No monster CRs found.'); addLineWithAnn('', ann); setBusy(false); return }
        const header = 'NAME                               INDEX   HP    STATE'
        addLine('output', header)
        addLine('output', '─'.repeat(header.length))
        const hps = dungeonCR.spec?.monsterHP ?? []
        for (let idx = 0; idx < count; idx++) {
          const name = `${dungeonName}-monster-${idx}`
          const hp = hps[idx] ?? '?'
          const state = (typeof hp === 'number' && hp > 0) ? 'alive' : 'dead'
          addLine('output', `${name.padEnd(35)} ${String(idx).padEnd(7)} ${String(hp).padEnd(5)} ${state}`)
        }
        addLineWithAnn('', ann)
        setBusy(false)
        return
      }

      // ── loot list ─────────────────────────────────────────────────────────
      if ((rt === 'loot' || rt === 'loots') && !rn && cmd.verb === 'get') {
        const count = dungeonCR.spec?.monsterHP?.length ?? 0
        const header = 'NAME                                    TYPE'
        addLine('output', header)
        addLine('output', '─'.repeat(header.length))
        let found = 0
        for (let idx = 0; idx < count; idx++) {
          const res = await getDungeonResource(dungeonNs, dungeonName, 'lootinfo', idx) as any
          if (res) {
            found++
            const lootName = `${dungeonName}-monster-${idx}-loot`
            const typeStr = res.data?.type ?? res.data?.itemType ?? '?'
            addLine('output', `${lootName.padEnd(40)} ${typeStr}`)
          }
        }
        // Boss loot
        const bossLoot = await getDungeonResource(dungeonNs, dungeonName, 'bosslootinfo') as any
        if (bossLoot) {
          found++
          const lootName = `${dungeonName}-boss-loot`
          const typeStr = bossLoot.data?.type ?? bossLoot.data?.itemType ?? '?'
          addLine('output', `${lootName.padEnd(40)} ${typeStr}`)
        }
        if (found === 0) addLine('output', 'No loot CRs found (monsters not yet killed).')
        addLineWithAnn('', ann)
        setBusy(false)
        return
      }

      // ── single-resource get/describe (hero, boss, treasure, modifier) ─────
      if (!spec) {
        addLine('error', `error: the server doesn't have a resource type "${rt}"`)
        addLine('output', `Resource types: ${RESOURCE_TYPES}`)
        setBusy(false)
        return
      }

      // Determine dungeon name and index from arguments
      // Pattern: kubectl get monster <dungeon-name> <index>
      //          kubectl get hero <dungeon-name>
      // rn = first positional after resource type = dungeon name OR index if already in current dungeon
      let targetDungeon = dungeonName
      let targetIdx: number | undefined

      if (spec.indexed) {
        // kubectl get monster <dungeon-name> <idx>  OR  kubectl get monster <idx>  (uses current dungeon)
        if (rn !== undefined) {
          const maybeIdx = parseInt(rn, 10)
          if (!isNaN(maybeIdx)) {
            // rn is an index — use current dungeon
            targetIdx = maybeIdx
          } else {
            // rn is a dungeon name, next positional (if any) from raw
            targetDungeon = rn
            // extract the index from the raw parts: kubectl get monster <dungeon> <idx>
            const rawParts = raw.trim().split(/\s+/)
            const startIdx = rawParts[0] === 'kubectl' ? 3 : 2
            const third = rawParts[startIdx]
            if (third && !third.startsWith('-')) targetIdx = parseInt(third, 10) || 0
            else targetIdx = 0
          }
        } else {
          targetIdx = 0
        }
      } else {
        if (rn) targetDungeon = rn
      }

      let resource: Record<string, unknown> | null = null
      try {
        resource = await getDungeonResource(
          dungeonNs, targetDungeon,
          spec.fetchKind as any,
          spec.indexed ? targetIdx : undefined
        ) as Record<string, unknown> | null
      } catch {
        resource = null
      }

      if (!resource) {
        const qualifier = spec.indexed ? ` (index ${targetIdx})` : ''
        addLine('error', `Error from server (NotFound): ${spec.singular} "${targetDungeon}"${qualifier} not found`)
        setBusy(false)
        return
      }

      if (yaml) {
        showYAML(resource, ann)
        setBusy(false)
        return
      }

      if (cmd.verb === 'describe') {
        const meta = resource.metadata as any ?? {}
        const rSpec = resource.spec as any ?? {}
        const rStatus = resource.status as any ?? {}
        const rData = resource.data as any // for ConfigMap-backed resources

        addLine('output', `Name:         ${meta.name ?? '?'}`)
        addLine('output', `Namespace:    ${meta.namespace ?? '?'}`)
        addLine('output', `APIVersion:   ${spec.apiVersion}`)
        addLine('output', `Kind:         ${spec.kind}`)
        addLine('output', '')

        if (Object.keys(rSpec).length > 0) {
          describeFields(Object.entries(rSpec), 'Spec')
          addLine('output', '')
        } else if (rData) {
          describeFields(Object.entries(rData), 'Data (kro-computed ConfigMap)')
          addLine('output', '')
        }
        if (Object.keys(rStatus).length > 0) {
          describeFields(Object.entries(rStatus), 'Status (kro-derived)')
        }
        addLineWithAnn('', ann)
      } else {
        // table row for single resource
        const meta = resource.metadata as any ?? {}
        const rSpec = resource.spec as any ?? {}
        const rStatus = resource.status as any ?? resource.data as any ?? {}
        const name = meta.name ?? '?'

        switch (rt) {
          case 'hero': case 'heroes': {
            addLine('output', 'NAME                               CLASS        HP     MANA   MAX-HP')
            addLine('output',
              `${name.padEnd(35)} ${(rSpec.heroClass ?? '?').padEnd(12)} ${String(rSpec.hp ?? '?').padEnd(6)} ${String(rSpec.mana ?? '?').padEnd(6)} ${rStatus.maxHP ?? '?'}`
            )
            break
          }
          case 'boss': case 'bosses': {
            addLine('output', 'NAME                               HP     MAX-HP   STATE     PHASE    MULT')
            addLine('output',
              `${name.padEnd(35)} ${String(rSpec.hp ?? '?').padEnd(6)} ${String(rSpec.maxHP ?? '?').padEnd(8)} ${(rStatus.entityState ?? '?').padEnd(9)} ${(rStatus.phase ?? rStatus.bossPhase ?? '?').padEnd(8)} ${rStatus.damageMultiplier ?? '?'}`
            )
            break
          }
          case 'monster': case 'monsters': {
            const idx = spec.indexed ? (targetIdx ?? 0) : 0
            addLine('output', 'NAME                               INDEX   HP    STATE')
            addLine('output',
              `${name.padEnd(35)} ${String(idx).padEnd(7)} ${String(rSpec.hp ?? '?').padEnd(5)} ${rStatus.entityState ?? '?'}`
            )
            break
          }
          case 'treasure': case 'treasures': {
            addLine('output', 'NAME                               STATE')
            addLine('output', `${name.padEnd(35)} ${rStatus.state ?? '?'}`)
            break
          }
          case 'modifier': case 'modifiers': {
            addLine('output', 'NAME                               TYPE                   EFFECT')
            const effect = (rStatus.effect ?? '?').slice(0, 50)
            addLine('output', `${name.padEnd(35)} ${(rSpec.modifierType ?? '?').padEnd(22)} ${effect}`)
            break
          }
          case 'loot': case 'loots': {
            addLine('output', 'NAME                               TYPE         RARITY')
            const lootSpec = rSpec as any
            addLine('output',
              `${name.padEnd(35)} ${(lootSpec.itemType ?? '?').padEnd(12)} ${lootSpec.rarity ?? '?'}`
            )
            break
          }
          default: {
            addLine('output', `${name}`)
          }
        }
        addLineWithAnn('', ann)
      }

    } catch (e: any) {
      const msg = e.message || ''
      if (msg.includes('404') || msg.includes('not found')) {
        addLine('error', `Error from server (NotFound): resource not found`)
      } else if (msg.includes('403') || msg.includes('forbidden')) {
        addLine('error', `Error from server (Forbidden): you do not own this resource`)
      } else {
        addLine('error', `error: ${msg}`)
      }
    }
    setBusy(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLine, addLineWithAnn, showYAML, dungeonNs, dungeonName, dungeonCR])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const cmd = input.trim()
      setInput('')
      if (cmd) executeCommand(cmd)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHistIdx(i => {
        const next = Math.min(i + 1, history.length - 1)
        if (history[next] !== undefined) setInput(history[next])
        return next
      })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHistIdx(i => {
        const next = Math.max(i - 1, -1)
        setInput(next === -1 ? '' : history[next] ?? '')
        return next
      })
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (input.includes('<name>') || input.includes('<dungeon>')) {
        setInput(input.replace('<name>', dungeonName).replace('<dungeon>', dungeonName))
      } else if (input === '' || input === 'k') {
        setInput('kubectl ')
      }
    }
  }, [input, history, executeCommand, dungeonName])

  return (
    <div className="kubectl-terminal" aria-label="kubectl terminal" data-testid="kubectl-terminal">
      <div className="kubectl-terminal-header">
        <span className="kubectl-terminal-title">
          <span className="kro-insight-badge" style={{ fontSize: 5 }}>kro</span>
          {' '}kubectl terminal — {dungeonName}
          <span style={{ opacity: 0.5, fontSize: 8, marginLeft: 6 }}>(read-only)</span>
        </span>
        <button className="modal-close" aria-label="Close terminal" onClick={onClose}>✕</button>
      </div>
      <div className="kubectl-terminal-body" onClick={() => inputRef.current?.focus()}>
        {lines.map(line => (
          <div key={line.id} className={`kt-line kt-${line.kind}`}>
            {line.kind === 'yaml' ? (
              <pre className="kt-yaml">{line.text}</pre>
            ) : (
              <span className="kt-text">{line.text}</span>
            )}
            {line.annotation && (
              <div className="kt-annotation">
                <button
                  className="kt-annotation-toggle"
                  onClick={e => { e.stopPropagation(); toggleAnnotation(line.id) }}
                  aria-expanded={line.annotationOpen}
                >
                  <span className="kro-insight-badge" style={{ fontSize: 5 }}>kro</span>
                  {' '}What just happened?{line.annotationOpen ? ' ▲' : ' ▼'}
                </button>
                {line.annotationOpen && (
                  <div className="kt-annotation-body">
                    <div className="kt-ann-what">{line.annotation.what}</div>
                    <div className="kt-ann-rgd">RGD: {line.annotation.rgd}</div>
                    {line.annotation.cel && <pre className="kt-ann-cel">{line.annotation.cel}</pre>}
                    <div className="kt-ann-concept">concept: {line.annotation.concept}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="kubectl-terminal-input-row">
        <span className="kt-prompt">
          {busy ? '⏳ ' : '$ '}
        </span>
        <input
          ref={inputRef}
          className="kt-input"
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
          placeholder={busy ? 'waiting...' : 'kubectl get dungeons'}
          aria-label="terminal input"
          data-testid="terminal-input"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>
    </div>
  )
}
