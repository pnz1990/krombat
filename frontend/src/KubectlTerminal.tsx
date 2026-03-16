/**
 * KubectlTerminal — fake CLI experience with real backend calls (#457)
 *
 * Renders a styled terminal panel that accepts kubectl-style commands,
 * maps them to the existing backend REST API, and prints kubectl-format output.
 * Every command response includes a collapsible "[kro] What just happened?" block
 * that explains which RGD was involved and the relevant CEL expression.
 *
 * No real kubectl binary runs. No cluster access is granted.
 * All security: auth, ownership checks, rate limiting — unchanged from REST API.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { listDungeons, getDungeon, createDungeon, deleteDungeon, DungeonCR } from './api'

// ─── kro annotations per command ─────────────────────────────────────────────
interface KroAnnotation {
  what: string
  rgd: string
  cel?: string
  concept: string
}

function kroAnnotationForCommand(cmd: string): KroAnnotation | null {
  const c = cmd.trim().toLowerCase()
  if (c.includes('apply') || c.includes('create')) {
    return {
      what: 'kro received the new Dungeon CR. dungeon-graph RGD reconciled: created Namespace, Hero CR, Monster CR ×N, Boss CR, Treasure CR, Modifier CR, GameConfig CM.',
      rgd: 'dungeon-graph',
      cel: `schema.spec.monsters > 0 ? schema.spec.monsters : 1   // forEach count\nstatus.heroMaxHP = heroClass == "warrior" ? 200 : heroClass == "mage" ? 120 : 150`,
      concept: 'resource-graph',
    }
  }
  if (c.includes('patch') && c.includes('attack')) {
    return {
      what: 'Attack CR created → kro reconciled dungeon-graph → combatResult specPatch CEL computed damage, wrote spec.heroHP / spec.monsterHP back.',
      rgd: 'dungeon-graph → combatResolve specPatch',
      cel: `heroDamage = int(baseDamage * classMultiplier) + weaponBonus\nnewMonsterHP = target.hp - heroDamage`,
      concept: 'spec-patch',
    }
  }
  if (c.includes('get') || c.includes('describe')) {
    return {
      what: 'kro continuously reconciles the Dungeon CR spec against the ResourceGraphDefinition schema. Every field you see was written by kro CEL or by the Go backend via spec-patch.',
      rgd: 'dungeon-graph (read)',
      cel: `status.bossPhase = bossHP <= maxBossHP * 0.25 ? "phase3" : bossHP <= maxBossHP * 0.5 ? "phase2" : "phase1"`,
      concept: 'reconcile-loop',
    }
  }
  if (c.includes('delete')) {
    return {
      what: 'Deleting the Dungeon CR cascades via ownerReferences: kro deletes all 9 child resources (Namespace, Hero CR, Monster CRs, Boss CR, Treasure CR, Modifier CR, ConfigMaps).',
      rgd: 'dungeon-graph (cleanup)',
      cel: `// kro sets ownerReference.blockOwnerDeletion=true on all children\n// K8s garbage collector cascades deletion automatically`,
      concept: 'owner-references',
    }
  }
  return null
}

// ─── YAML template for apply ──────────────────────────────────────────────────
function dungeonYAML(name: string, monsters: number, difficulty: string, heroClass: string): string {
  return `apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: ${name}
  namespace: default
spec:
  monsters: ${monsters}
  difficulty: ${difficulty}
  heroClass: ${heroClass}
  # kro dungeon-graph RGD will reconcile this CR and create:
  #   Namespace, Hero CR, Monster CR ×${monsters}, Boss CR,
  #   Treasure CR, Modifier CR, GameConfig CM`
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

// ─── Command parser ───────────────────────────────────────────────────────────
interface ParsedCmd {
  verb: 'apply' | 'get' | 'describe' | 'patch' | 'delete' | 'cat' | 'help' | 'clear' | 'unknown'
  resourceType?: string
  resourceName?: string
  flags: Record<string, string>
  raw: string
}

function parseKubectl(raw: string): ParsedCmd {
  const parts = raw.trim().split(/\s+/)
  const flags: Record<string, string> = {}
  const positional: string[] = []
  let i = 0

  // skip 'kubectl' if present
  if (parts[0] === 'kubectl') i = 1

  const verb = (parts[i++] || 'help').toLowerCase() as ParsedCmd['verb']

  for (; i < parts.length; i++) {
    if (parts[i].startsWith('--')) {
      const [k, ...v] = parts[i].slice(2).split('=')
      flags[k] = v.join('=') || parts[++i] || ''
    } else if (parts[i] === '-p' || parts[i] === '-f') {
      flags[parts[i].slice(1)] = parts[++i] || ''
    } else if (!parts[i].startsWith('-')) {
      positional.push(parts[i])
    }
  }

  // 'cat dungeon.yaml' special case
  if ((verb as string) === 'cat') {
    return { verb: 'cat', flags, raw }
  }

  // handle 'help' / 'clear'
  if ((verb as string) === 'help' || (verb as string) === '--help' || (verb as string) === '-h') {
    return { verb: 'help', flags, raw }
  }
  if ((verb as string) === 'clear') {
    return { verb: 'clear', flags, raw }
  }

  const resourceType = positional[0]?.toLowerCase()
  const resourceName = positional[1]

  if (!['apply', 'get', 'describe', 'patch', 'delete'].includes(verb)) {
    return { verb: 'unknown', resourceType, resourceName, flags, raw }
  }

  return { verb: verb as ParsedCmd['verb'], resourceType, resourceName, flags, raw }
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

const HELP_TEXT = `Available commands:
  kubectl apply -f dungeon.yaml         Create a new dungeon
  kubectl get dungeons                  List your dungeons
  kubectl get dungeon <name>            Show dungeon spec
  kubectl describe dungeon <name>       Verbose dungeon info
  kubectl patch dungeon <name> \\
    -p '{"spec":{"attackTarget":"..."}}'  Attack (simplified)
  kubectl delete dungeon <name>         Delete a dungeon
  cat dungeon.yaml                      Show dungeon YAML template
  clear                                 Clear terminal
  help                                  Show this help

Every command shows a [kro] annotation explaining what happened.`

export function KubectlTerminal({ dungeonNs, dungeonName, dungeonCR, onClose }: KubectlTerminalProps) {
  const [lines, setLines] = useState<OutputLine[]>([
    { id: nextId(), kind: 'output', text: `# kubectl terminal — dungeon/${dungeonName} (#457)` },
    { id: nextId(), kind: 'output', text: `# Type 'help' for available commands. Real API calls, kubectl-format output.` },
    { id: nextId(), kind: 'output', text: '' },
  ])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Scroll to bottom on new output
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const addLine = useCallback((kind: LineKind, text: string, annotation?: KroAnnotation) => {
    setLines(prev => [...prev, { id: nextId(), kind, text, annotation, annotationOpen: false }])
  }, [])

  const toggleAnnotation = useCallback((id: number) => {
    setLines(prev => prev.map(l => l.id === id ? { ...l, annotationOpen: !l.annotationOpen } : l))
  }, [])

  const formatSpec = (spec: any): string => {
    if (!spec) return '(no spec)'
    const fields = [
      `heroClass: ${spec.heroClass ?? '?'}`, `difficulty: ${spec.difficulty ?? '?'}`,
      `heroHP: ${spec.heroHP ?? '?'} / ${spec.heroMana !== undefined ? `mana: ${spec.heroMana}` : ''}`,
      `monsters: ${spec.monsters ?? '?'}  bossHP: ${spec.bossHP ?? '?'}`,
      `currentRoom: ${spec.currentRoom ?? 1}`,
    ]
    return fields.join('\n  ')
  }

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
      if (cmd.verb === 'clear') {
        setLines([])
        setBusy(false)
        return
      }

      // ── help ──────────────────────────────────────────────────────────────
      if (cmd.verb === 'help') {
        HELP_TEXT.split('\n').forEach(l => addLine('output', l))
        setBusy(false)
        return
      }

      // ── cat dungeon.yaml ──────────────────────────────────────────────────
      if (cmd.verb === 'cat') {
        const yaml = dungeonYAML(dungeonName, dungeonCR.spec?.monsters ?? 3, dungeonCR.spec?.difficulty ?? 'normal', dungeonCR.spec?.heroClass ?? 'warrior')
        addLine('yaml', yaml)
        setBusy(false)
        return
      }

      // ── unknown ───────────────────────────────────────────────────────────
      if (cmd.verb === 'unknown') {
        addLine('error', `error: unknown command "${raw.split(' ')[0]}" — type 'help' to see available commands`)
        setBusy(false)
        return
      }

      // ── kubectl apply -f dungeon.yaml ─────────────────────────────────────
      if (cmd.verb === 'apply') {
        const fFlag = cmd.flags['f'] || ''
        if (!fFlag.includes('dungeon')) {
          addLine('error', `error: -f flag must reference dungeon.yaml`)
          setBusy(false)
          return
        }
        // Extract name from YAML flag or use current dungeon name variant
        const newName = `${dungeonName}-t${Date.now() % 10000}`
        try {
          await createDungeon(newName, 3, 'normal', 'warrior', dungeonNs)
          const line: OutputLine = {
            id: nextId(), kind: 'output',
            text: `dungeon.game.k8s.example/${newName} created`,
            annotation: ann ?? undefined, annotationOpen: false,
          }
          setLines(prev => [...prev, line])
        } catch (e: any) {
          addLine('error', `Error from server: ${e.message}`)
          setBusy(false)
          return
        }
        setBusy(false)
        return
      }

      // ── kubectl get dungeons ──────────────────────────────────────────────
      if (cmd.verb === 'get' && (!cmd.resourceType || cmd.resourceType === 'dungeons' || cmd.resourceType === 'dungeon') && !cmd.resourceName) {
        try {
          const list = await listDungeons()
          if (list.length === 0) {
            addLine('output', 'No resources found in default namespace.')
            setBusy(false)
            return
          }
          const header = 'NAME                          DIFFICULTY   BOSS-STATE    MONSTERS   MOD'
          addLine('output', header)
          addLine('output', '─'.repeat(header.length))
          for (const d of list) {
            const name = d.name.padEnd(30)
            const diff = (d.difficulty ?? '?').padEnd(12)
            const boss = (d.bossState ?? '?').padEnd(13)
            const mons = String(d.livingMonsters ?? '?').padEnd(10)
            const mod = d.modifier ?? 'none'
            addLine('output', `${name} ${diff} ${boss} ${mons} ${mod}`)
          }
          const lineWithAnn: OutputLine = { id: nextId(), kind: 'output', text: '', annotation: ann ?? undefined, annotationOpen: false }
          setLines(prev => [...prev, lineWithAnn])
        } catch (e: any) {
          addLine('error', `Error from server: ${e.message}`)
        }
        setBusy(false)
        return
      }

      // ── kubectl get/describe dungeon <name> ───────────────────────────────
      if ((cmd.verb === 'get' || cmd.verb === 'describe') && cmd.resourceName) {
        try {
          const d = await getDungeon(dungeonNs, cmd.resourceName)
          const spec = d.spec || {}
          if (cmd.verb === 'describe') {
            addLine('output', `Name:         ${d.metadata.name}`)
            addLine('output', `Namespace:    ${d.metadata.namespace}`)
            addLine('output', `API Version:  game.k8s.example/v1alpha1`)
            addLine('output', `Kind:         Dungeon`)
            addLine('output', ``)
            addLine('output', `Spec:`)
            addLine('output', `  ${formatSpec(spec)}`)
            addLine('output', ``)
            addLine('output', `Status (kro-derived):`)
            if (d.status) {
              for (const [k, v] of Object.entries(d.status)) {
                addLine('output', `  ${k}: ${v}`)
              }
            }
          } else {
            const name = (d.metadata.name ?? '').padEnd(30)
            const cls = (spec.heroClass ?? '?').padEnd(12)
            const diff = (spec.difficulty ?? '?').padEnd(12)
            const hp = String(spec.heroHP ?? '?').padEnd(6)
            const bossHp = String(spec.bossHP ?? '?').padEnd(9)
            const room = String(spec.currentRoom ?? 1)
            addLine('output', 'NAME                          HERO-CLASS   DIFFICULTY   HP     BOSS-HP   ROOM')
            addLine('output', `${name} ${cls} ${diff} ${hp} ${bossHp} ${room}`)
          }
          const lineWithAnn: OutputLine = { id: nextId(), kind: 'output', text: '', annotation: ann ?? undefined, annotationOpen: false }
          setLines(prev => [...prev, lineWithAnn])
        } catch (e: any) {
          const msg = e.message || ''
          if (msg.includes('404') || msg.includes('not found')) {
            addLine('error', `Error from server (NotFound): dungeons "${cmd.resourceName}" not found`)
          } else if (msg.includes('403') || msg.includes('forbidden')) {
            addLine('error', `Error from server (Forbidden): dungeons "${cmd.resourceName}" is forbidden: user does not own this resource`)
          } else {
            addLine('error', `Error from server: ${e.message}`)
          }
        }
        setBusy(false)
        return
      }

      // ── kubectl patch dungeon <name> ... ──────────────────────────────────
      if (cmd.verb === 'patch' && cmd.resourceName) {
        // For demo purposes patch = describe current state (real attack goes through UI)
        addLine('output', `dungeon.game.k8s.example/${cmd.resourceName} patched`)
        addLine('output', `# Note: use the game UI to submit attacks — spec mutations flow through`)
        addLine('output', `# the backend → kro reconcile loop → specPatch CEL writes the result.`)
        const lineWithAnn: OutputLine = { id: nextId(), kind: 'output', text: '', annotation: ann ?? undefined, annotationOpen: false }
        setLines(prev => [...prev, lineWithAnn])
        setBusy(false)
        return
      }

      // ── kubectl delete dungeon <name> ─────────────────────────────────────
      if (cmd.verb === 'delete' && cmd.resourceName) {
        try {
          await deleteDungeon(dungeonNs, cmd.resourceName)
          const lineWithAnn: OutputLine = {
            id: nextId(), kind: 'output',
            text: `dungeon.game.k8s.example "${cmd.resourceName}" deleted`,
            annotation: ann ?? undefined, annotationOpen: false,
          }
          setLines(prev => [...prev, lineWithAnn])
        } catch (e: any) {
          const msg = e.message || ''
          if (msg.includes('404') || msg.includes('not found')) {
            addLine('error', `Error from server (NotFound): dungeons "${cmd.resourceName}" not found`)
          } else if (msg.includes('403') || msg.includes('forbidden')) {
            addLine('error', `Error from server (Forbidden): dungeons "${cmd.resourceName}" is forbidden`)
          } else {
            addLine('error', `Error from server: ${e.message}`)
          }
        }
        setBusy(false)
        return
      }

      // Fallthrough — unknown resource type
      addLine('error', `error: the server doesn't have a resource type "${cmd.resourceType || cmd.verb}"`)

    } catch (e: any) {
      addLine('error', `error: ${e.message}`)
    }
    setBusy(false)
  }, [addLine, dungeonNs, dungeonName, dungeonCR])

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
      // Basic autocomplete: if starts with 'kubectl ', suggest dungeon name
      if (input.includes('<name>') || (input.endsWith(' ') && input.includes('dungeon '))) {
        setInput(input.replace('<name>', dungeonName))
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
