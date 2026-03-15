/**
 * KroGraph — Live kro Resource Graph Panel
 *
 * Renders the dungeon's live ResourceGraphDefinition tree as an SVG DAG.
 * Every node reflects real-time state from the DungeonCR spec/status.
 * Clicking a node opens the relevant kro concept modal.
 *
 * Layout (fixed, pixel-art aesthetic):
 *
 *   [dungeon-graph RGD]  ← ResourceGroup CRD (kro)
 *       └── [Dungeon CR]  ← root CR instance
 *               ├── [Namespace]
 *       ├── [Hero CR] → [hero CM]
 *       ├── [Monster CR ×N] → [monsterState CM] → [Loot CR?] → [lootSecret?]
 *       ├── [Boss CR] → [boss CM] → [Loot CR?]
 *       ├── [Treasure CR] → [treasure-state CM] → [treasureSecret?]
 *       ├── [Modifier CR?] → [modifierState CM]
 *       ├── [combatResolve specPatch]
 *       ├── [actionResolve specPatch]
 *       └── [gameConfig CM]
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { DungeonCR, ResourceKind } from './api'
import type { KroConceptId } from './KroTeach'

// ─── Node types ──────────────────────────────────────────────────────────────

type NodeState = 'alive' | 'dead' | 'ready' | 'pending' | 'defeated' | 'locked' | 'reconciling' | 'ok' | 'meta'

interface GraphNode {
  id: string
  label: string        // short display label
  kind: string         // K8s kind
  state: NodeState
  exists: boolean      // false = includeWhen blocked, shown as outline
  concept: KroConceptId | null
  detail?: string      // short status line shown below label
  pulse?: boolean      // true during reconcile window
}

interface GraphEdge {
  from: string
  to: string
  label?: string       // relationship annotation
  dashed?: boolean     // dashed = conditional (includeWhen)
}

// ─── Build graph from DungeonCR ──────────────────────────────────────────────

export function buildGraph(cr: DungeonCR, reconciling: boolean): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const spec = cr.spec
  const status = cr.status
  const name = cr.metadata.name
  const monsterHP: number[] = spec.monsterHP || []
  const allMonstersDead = monsterHP.length > 0 && monsterHP.every(hp => hp <= 0)
  const bossHP = spec.bossHP ?? 0
  const bossDefeated = bossHP <= 0 && allMonstersDead
  const hasModifier = !!spec.modifier && spec.modifier !== 'none'
  const treasureOpened = (spec.treasureOpened ?? 0) === 1

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  // Root -1: ResourceGroup CRD (the dungeon-graph RGD that defines the Dungeon CR API)
  nodes.push({
    id: 'resourcegroup',
    label: 'dungeon-graph',
    kind: 'ResourceGroup',
    state: 'meta',
    exists: true,
    concept: 'rgd',
    detail: 'kro RGD → registers Dungeon CRD',
  })
  edges.push({ from: 'resourcegroup', to: 'dungeon', label: 'defines' })

  // Root: Dungeon CR
  const dungeonState: NodeState = reconciling ? 'reconciling'
    : status?.victory ? 'alive'
    : spec.heroHP <= 0 ? 'dead'
    : 'alive'
  nodes.push({
    id: 'dungeon',
    label: name.length > 12 ? name.slice(0, 10) + '..' : name,
    kind: 'Dungeon',
    state: dungeonState,
    exists: true,
    concept: 'rgd',
    detail: `spec.difficulty=${spec.difficulty}`,
    pulse: reconciling,
  })

  // Namespace
  nodes.push({
    id: 'namespace',
    label: 'default',
    kind: 'Namespace',
    state: 'ok',
    exists: true,
    concept: 'rgd',
    detail: 'created by dungeon-graph',
  })
  edges.push({ from: 'dungeon', to: 'namespace' })

  // Hero CR
  const heroState: NodeState = (spec.heroHP ?? 100) <= 0 ? 'defeated' : reconciling ? 'reconciling' : 'alive'
  nodes.push({
    id: 'hero',
    label: `Hero`,
    kind: 'Hero CR',
    state: heroState,
    exists: true,
    concept: 'resource-chaining',
    detail: `HP: ${spec.heroHP}/${status?.maxHeroHP ?? '?'} · ${spec.heroClass || 'warrior'}`,
    pulse: reconciling,
  })
  edges.push({ from: 'dungeon', to: 'hero' })

  // heroState ConfigMap
  nodes.push({
    id: 'hero-cm',
    label: 'heroState',
    kind: 'ConfigMap',
    state: 'ok',
    exists: true,
    concept: 'cel-basics',
    detail: `entityState=${heroState === 'defeated' ? 'defeated' : 'alive'}`,
  })
  edges.push({ from: 'hero', to: 'hero-cm', label: 'hero-graph' })

  // Monster CRs (show up to 4 collapsed if more)
  const totalMonsters = monsterHP.length
  const showMonsters = Math.min(totalMonsters, 4)
  for (let i = 0; i < showMonsters; i++) {
    const hp = monsterHP[i]
    const mState: NodeState = reconciling && hp > 0 ? 'reconciling' : hp > 0 ? 'alive' : 'dead'
    const mId = `monster-${i}`
    nodes.push({
      id: mId,
      label: `M${i}`,
      kind: 'Monster CR',
      state: mState,
      exists: true,
      concept: 'forEach',
      detail: `HP: ${hp}/${status?.maxMonsterHP ?? '?'} · forEach item ${i + 1}/${totalMonsters}`,
      pulse: reconciling && hp > 0,
    })
    // First edge shows forEach ×N count to make fan-out visible
    edges.push({ from: 'dungeon', to: mId, label: i === 0 ? `forEach ×${totalMonsters}` : undefined })

    // monsterState ConfigMap
    const mcmId = `monster-cm-${i}`
    nodes.push({
      id: mcmId,
      label: `m${i}State`,
      kind: 'ConfigMap',
      state: hp > 0 ? 'alive' : 'dead',
      exists: true,
      concept: 'cel-basics',
      detail: hp > 0 ? 'entityState=alive' : 'entityState=dead',
    })
    edges.push({ from: mId, to: mcmId, label: 'monster-graph' })

    // Loot CR (includeWhen: hp==0)
    const lootId = `loot-m${i}`
    const lootExists = hp <= 0
    nodes.push({
      id: lootId,
      label: `Loot`,
      kind: 'Loot CR',
      state: lootExists ? 'ok' : 'locked',
      exists: lootExists,
      concept: 'includeWhen',
      detail: lootExists ? 'dropped on kill' : 'includeWhen: hp==0',
    })
    edges.push({ from: mcmId, to: lootId, label: 'includeWhen', dashed: true })

    // lootInfo ConfigMap (created by loot-graph — item description text)
    const lootInfoId = `loot-info-m${i}`
    nodes.push({
      id: lootInfoId,
      label: 'LootInfo',
      kind: 'ConfigMap',
      state: lootExists ? 'ok' : 'locked',
      exists: lootExists,
      concept: 'cel-basics',
      detail: lootExists ? 'item description CM' : 'created by loot-graph',
    })
    edges.push({ from: lootId, to: lootInfoId, label: 'loot-graph', dashed: !lootExists })

    // lootSecret Secret (created by loot-graph when Loot CR exists)
    const lootSecretId = `loot-secret-m${i}`
    nodes.push({
      id: lootSecretId,
      label: 'LootSecret',
      kind: 'Secret',
      state: lootExists ? 'ok' : 'locked',
      exists: lootExists,
      concept: 'secret-output',
      detail: lootExists ? 'item data in Secret' : 'created by loot-graph',
    })
    edges.push({ from: lootId, to: lootSecretId, label: 'loot-graph', dashed: !lootExists })
  }
  if (totalMonsters > 4) {
    nodes.push({
      id: 'monster-more',
      label: `+${totalMonsters - 4} more`,
      kind: 'Monster CR',
      state: 'ok',
      exists: true,
      concept: 'forEach',
      detail: `${totalMonsters - 4} additional monsters (forEach ×${totalMonsters} total)`,
    })
    edges.push({ from: 'dungeon', to: 'monster-more' })
  }

  // Boss CR
  const bossState: NodeState = reconciling ? 'reconciling'
    : bossDefeated ? 'defeated'
    : allMonstersDead ? 'ready'
    : 'pending'
  nodes.push({
    id: 'boss',
    label: 'Boss',
    kind: 'Boss CR',
    state: bossState,
    exists: true,
    concept: 'cel-ternary',
    detail: `HP: ${bossHP}/${status?.maxBossHP ?? '?'} · ${bossState}`,
    pulse: reconciling,
  })
  edges.push({ from: 'dungeon', to: 'boss' })

  // bossState ConfigMap
  nodes.push({
    id: 'boss-cm',
    label: 'bossState',
    kind: 'ConfigMap',
    state: bossState === 'defeated' ? 'defeated' : bossState === 'ready' ? 'ready' : 'pending',
    exists: true,
    concept: 'cel-ternary',
    detail: `entityState=${bossState}`,
  })
  edges.push({ from: 'boss', to: 'boss-cm', label: 'boss-graph' })

  // Boss Loot CR (includeWhen: hp==0)
  const bossLootExists = bossDefeated
  nodes.push({
    id: 'boss-loot',
    label: 'BossLoot',
    kind: 'Loot CR',
    state: bossLootExists ? 'ok' : 'locked',
    exists: bossLootExists,
    concept: 'includeWhen',
    detail: bossLootExists ? 'guaranteed drop' : 'includeWhen: hp==0',
  })
  edges.push({ from: 'boss', to: 'boss-loot', label: 'boss-graph', dashed: !bossLootExists })

  // Boss lootInfo ConfigMap (created by loot-graph — item description text)
  nodes.push({
    id: 'boss-loot-info',
    label: 'BossLootInfo',
    kind: 'ConfigMap',
    state: bossLootExists ? 'ok' : 'locked',
    exists: bossLootExists,
    concept: 'cel-basics',
    detail: bossLootExists ? 'boss item description CM' : 'created by loot-graph',
  })
  edges.push({ from: 'boss-loot', to: 'boss-loot-info', label: 'loot-graph', dashed: !bossLootExists })

  // Boss lootSecret Secret (created by loot-graph)
  nodes.push({
    id: 'boss-loot-secret',
    label: 'BossLootSecret',
    kind: 'Secret',
    state: bossLootExists ? 'ok' : 'locked',
    exists: bossLootExists,
    concept: 'secret-output',
    detail: bossLootExists ? 'boss item in Secret' : 'created by loot-graph',
  })
  edges.push({ from: 'boss-loot', to: 'boss-loot-secret', label: 'loot-graph', dashed: !bossLootExists })

  // Treasure CR
  const treasureState: NodeState = treasureOpened ? 'ok' : 'pending'
  nodes.push({
    id: 'treasure',
    label: 'Treasure',
    kind: 'Treasure CR',
    state: treasureState,
    exists: true,
    concept: 'secret-output',
    detail: `opened=${treasureOpened ? 1 : 0}`,
  })
  edges.push({ from: 'dungeon', to: 'treasure' })

  // treasureState ConfigMap
  nodes.push({
    id: 'treasure-cm',
    label: 'treasureState',
    kind: 'ConfigMap',
    state: treasureOpened ? 'ok' : 'pending',
    exists: true,
    concept: 'secret-output',
    detail: treasureOpened ? 'opened' : 'unopened',
  })
  edges.push({ from: 'treasure', to: 'treasure-cm', label: 'treasure-graph' })

  // treasureSecret Secret (includeWhen: opened==1)
  nodes.push({
    id: 'treasure-secret',
    label: 'Key Secret',
    kind: 'Secret',
    state: treasureOpened ? 'ok' : 'locked',
    exists: treasureOpened,
    concept: 'secret-output',
    detail: treasureOpened ? 'holds dungeon key' : 'includeWhen: opened==1',
  })
  edges.push({ from: 'treasure-cm', to: 'treasure-secret', label: 'includeWhen', dashed: true })

  // Modifier CR (includeWhen: modifier != "none")
  nodes.push({
    id: 'modifier',
    label: hasModifier ? (spec.modifier || 'modifier').slice(0, 8) : 'Modifier',
    kind: 'Modifier CR',
    state: hasModifier ? 'ok' : 'locked',
    exists: hasModifier,
    concept: 'readyWhen',
    detail: hasModifier ? `type=${status?.modifierType || '?'}` : 'includeWhen: modifier!="none"',
  })
  edges.push({ from: 'dungeon', to: 'modifier', label: 'includeWhen', dashed: !hasModifier })

  if (hasModifier) {
    nodes.push({
      id: 'modifier-cm',
      label: 'modifierState',
      kind: 'ConfigMap',
      state: status?.modifierType ? 'ok' : 'pending',
      exists: true,
      concept: 'readyWhen',
      detail: `readyWhen: modifierType!=''`,
    })
    edges.push({ from: 'modifier', to: 'modifier-cm', label: 'modifier-graph\nreadyWhen' })
  }

  // specPatch nodes — virtual nodes in dungeon-graph that write back to spec
  // (combat, action, DoT, taunt, cooldown, ring, room2 transitions)
  nodes.push({
    id: 'combat-cm',
    label: 'combatResolve',
    kind: 'specPatch',
    state: reconciling ? 'reconciling' : 'ok',
    exists: true,
    concept: 'cel-basics',
    detail: reconciling ? 'CEL writing spec.monsterHP/bossHP' : `dice: ${status?.diceFormula || '?'}`,
    pulse: reconciling,
  })
  edges.push({ from: 'dungeon', to: 'combat-cm', label: 'specPatch' })

  // actionResolve specPatch node
  nodes.push({
    id: 'action-cm',
    label: 'actionResolve',
    kind: 'specPatch',
    state: reconciling ? 'reconciling' : 'ok',
    exists: true,
    concept: 'spec-mutation',
    detail: 'equip/use/door/room logic',
  })
  edges.push({ from: 'dungeon', to: 'action-cm', label: 'specPatch' })

  // gameConfig ConfigMap
  nodes.push({
    id: 'gameconfig-cm',
    label: 'gameConfig',
    kind: 'ConfigMap',
    state: 'ok',
    exists: true,
    concept: 'spec-schema',
    detail: `counters, maxHP values`,
  })
  edges.push({ from: 'dungeon', to: 'gameconfig-cm' })

  // Ephemeral Attack CR — appears during reconcile (combat), teaches empty-RGD + externalRef
  nodes.push({
    id: 'attack-cr',
    label: 'Attack CR',
    kind: 'Attack (RGD)',
    state: reconciling ? 'reconciling' : 'locked',
    exists: reconciling,
    concept: 'empty-rgd',
    detail: reconciling ? 'attack-graph CRD factory — triggers combatResolve' : 'resources:[] CRD factory',
    pulse: reconciling,
  })
  edges.push({ from: 'dungeon', to: 'attack-cr', label: 'spec patch', dashed: !reconciling })

  // Ephemeral Action CR — appears during reconcile (items/room/treasure), teaches empty-RGD
  nodes.push({
    id: 'action-cr',
    label: 'Action CR',
    kind: 'Action (RGD)',
    state: reconciling ? 'reconciling' : 'locked',
    exists: reconciling,
    concept: 'empty-rgd',
    detail: reconciling ? 'action-graph CRD factory — triggers actionResolve' : 'resources:[] CRD factory',
    pulse: reconciling,
  })
  edges.push({ from: 'dungeon', to: 'action-cr', label: 'spec patch', dashed: !reconciling })

  return { nodes, edges }
}

// ─── Layout engine ───────────────────────────────────────────────────────────
//
// Top-down row layout:
//   Row 0 (y=0):   Dungeon CR  (centered)
//   Row 1 (y=56):  Hero, Monster×N, Boss, Treasure, Modifier, Namespace
//   Row 2 (y=112): CMs for each row-1 CR  (aligned under parent)
//   Row 3 (y=168): Conditional outputs (Loot CRs, Secrets)
//   Row 4 (y=224): combatResult, actionResult, gameConfig, Attack CR (ephemeral), Action CR (ephemeral)

interface NodePos { x: number; y: number; w: number; h: number }

const NODE_W = 82
const NODE_H = 36
const H_GAP = 94    // horizontal gap between node centers
const V_GAP = 56    // vertical gap between rows

function layoutGraph(nodes: GraphNode[], _edges: GraphEdge[]): Map<string, NodePos> {
  const positions = new Map<string, NodePos>()

  // Row assignments
  const row = (id: string): number => {
    if (id === 'resourcegroup') return -1
    if (id === 'dungeon') return 0
    if (id === 'namespace' || id === 'hero' || id.match(/^monster-\d+$/) || id === 'monster-more'
        || id === 'boss' || id === 'treasure' || id === 'modifier') return 1
    if (id === 'hero-cm' || id.match(/^monster-cm-\d+$/) || id === 'boss-cm'
        || id === 'treasure-cm' || id === 'modifier-cm') return 2
    if (id.match(/^loot-m\d+$/) || id === 'boss-loot' || id === 'treasure-secret') return 3
    if (id === 'combat-cm' || id === 'action-cm' || id === 'gameconfig-cm') return 4
    if (id === 'attack-cr' || id === 'action-cr') return 4
    return 1
  }

  // Group by row, preserve insertion order (which matches left-to-right intent)
  const rows: Map<number, string[]> = new Map()
  for (const n of nodes) {
    const r = row(n.id)
    if (!rows.has(r)) rows.set(r, [])
    rows.get(r)!.push(n.id)
  }

  // For each row, distribute nodes evenly and center the whole row
  const totalWidth = (ids: string[]) => ids.length * H_GAP
  // Find max row width to determine overall canvas width
  let maxRowW = 0
  for (const ids of rows.values()) maxRowW = Math.max(maxRowW, totalWidth(ids))

  for (const [r, ids] of rows) {
    const rowW = totalWidth(ids)
    const startX = (maxRowW - rowW) / 2 + H_GAP / 2 - NODE_W / 2
    ids.forEach((id, i) => {
      positions.set(id, {
        x: startX + i * H_GAP,
        y: r * V_GAP + 8,
        w: NODE_W,
        h: NODE_H,
      })
    })
  }

  // Shift all nodes down so minimum y is always >= 8
  let minY = Infinity
  for (const pos of positions.values()) minY = Math.min(minY, pos.y)
  if (minY < 8) {
    const shift = 8 - minY
    for (const pos of positions.values()) pos.y += shift
  }

  return positions
}

// ─── Color mapping ───────────────────────────────────────────────────────────

function stateColor(state: NodeState, exists: boolean): { border: string; bg: string; text: string } {
  if (!exists) return { border: '#2a2a4a', bg: '#0d0d1a', text: '#333' }
  switch (state) {
    case 'alive':       return { border: '#00ff41', bg: '#0a1f0a', text: '#00ff41' }
    case 'ready':       return { border: '#f5c518', bg: '#1a1500', text: '#f5c518' }
    case 'pending':     return { border: '#555', bg: '#111', text: '#888' }
    case 'dead':        return { border: '#e94560', bg: '#1a0a0a', text: '#e94560' }
    case 'defeated':    return { border: '#9b59b6', bg: '#130a1a', text: '#9b59b6' }
    case 'reconciling': return { border: '#00d4ff', bg: '#0a1520', text: '#00d4ff' }
    case 'locked':      return { border: '#222', bg: '#0a0a12', text: '#333' }
    case 'ok':          return { border: '#2a4a6a', bg: '#0a1420', text: '#5dade2' }
    case 'meta':        return { border: '#9b59b6', bg: '#120a1a', text: '#c39bd3' }
    default:            return { border: '#333', bg: '#111', text: '#888' }
  }
}

// ─── SVG Graph Component ─────────────────────────────────────────────────────

interface KroGraphProps {
  cr: DungeonCR
  reconciling: boolean
  onNodeClick: (conceptId: KroConceptId) => void
  onNodeSelect?: (nodeId: string, kind: string) => void
}

export function KroGraph({ cr, reconciling, onNodeClick, onNodeSelect }: KroGraphProps) {
  const { nodes, edges } = buildGraph(cr, reconciling)
  const positions = layoutGraph(nodes, edges)
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  // Compute SVG dimensions
  let maxX = 0, maxY = 0
  for (const pos of positions.values()) {
    maxX = Math.max(maxX, pos.x + pos.w)
    maxY = Math.max(maxY, pos.y + pos.h)
  }
  const svgW = maxX + 16
  const svgH = maxY + 16

  const [hovered, setHovered] = useState<string | null>(null)
  const [pulseFrame, setPulseFrame] = useState(0)

  // Pulse animation for reconciling nodes
  useEffect(() => {
    if (!reconciling) return
    const id = setInterval(() => setPulseFrame(f => (f + 1) % 6), 200)
    return () => clearInterval(id)
  }, [reconciling])

  return (
    <div className="kro-graph-wrap">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ display: 'block', overflow: 'visible' }}
        aria-label="kro resource graph"
      >
        <defs>
          <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="3" refY="6" orient="auto">
            <path d="M0,0 L6,0 L3,6 z" fill="#2a4a6a" />
          </marker>
          <marker id="arrowhead-active" markerWidth="6" markerHeight="6" refX="3" refY="6" orient="auto">
            <path d="M0,0 L6,0 L3,6 z" fill="#00d4ff" />
          </marker>
          <marker id="arrowhead-dashed" markerWidth="6" markerHeight="6" refX="3" refY="6" orient="auto">
            <path d="M0,0 L6,0 L3,6 z" fill="#333" />
          </marker>
        </defs>

        {/* Edges — drawn first (behind nodes) */}
        {edges.map((edge, i) => {
          const fromPos = positions.get(edge.from)
          const toPos = positions.get(edge.to)
          if (!fromPos || !toPos) return null

          const fromNode = nodeMap.get(edge.from)
          const toNode = nodeMap.get(edge.to)
          const isActive = reconciling && (fromNode?.pulse || toNode?.pulse)
          const isExistEdge = toNode?.exists !== false

          // Top-down edges: from bottom-center of parent to top-center of child
          const x1 = fromPos.x + fromPos.w / 2
          const y1 = fromPos.y + fromPos.h
          const x2 = toPos.x + toPos.w / 2
          const y2 = toPos.y

          // Cubic bezier curves for clean top-down flow
          const my = (y1 + y2) / 2
          const path = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`

          const stroke = isActive ? '#00d4ff' : edge.dashed ? '#2a2a4a' : '#1e3a5f'
          const marker = isActive ? 'url(#arrowhead-active)' : edge.dashed ? 'url(#arrowhead-dashed)' : 'url(#arrowhead)'

          return (
            <g key={i}>
              <path
                d={path}
                fill="none"
                stroke={stroke}
                strokeWidth={isActive ? 1.5 : 1}
                strokeDasharray={edge.dashed ? '4,3' : undefined}
                markerEnd={marker}
                opacity={isExistEdge ? 1 : 0.3}
              />
              {edge.label && (
                <text
                  x={(x1 + x2) / 2 + 4}
                  y={my - 2}
                  textAnchor="middle"
                  fontSize={5}
                  fill={isActive ? '#00d4ff' : '#2a4a6a'}
                  style={{ fontFamily: "'Press Start 2P', monospace" }}
                >
                  {edge.label.split('\n').map((line, li) => (
                    <tspan key={li} x={(x1 + x2) / 2 + 4} dy={li === 0 ? 0 : 7}>{line}</tspan>
                  ))}
                </text>
              )}
            </g>
          )
        })}

        {/* Nodes */}
        {nodes.map(node => {
          const pos = positions.get(node.id)
          if (!pos) return null

          const colors = stateColor(node.state, node.exists)
          const isHovered = hovered === node.id
          const isPulsing = node.pulse && reconciling
          const pulseOpacity = isPulsing ? 0.3 + (Math.sin(pulseFrame * Math.PI / 3) + 1) * 0.35 : 0
          const canClick = !!node.concept

          return (
            <g
              key={node.id}
              transform={`translate(${pos.x},${pos.y})`}
              style={{ cursor: canClick ? 'pointer' : 'default' }}
              onClick={() => {
                if (!canClick) return
                if (node.concept) onNodeClick(node.concept)
                onNodeSelect?.(node.id, node.kind)
              }}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              role={canClick ? 'button' : undefined}
              aria-label={`${node.kind}: ${node.label} — ${node.state}`}
            >
              {/* Pulse glow */}
              {isPulsing && (
                <rect
                  x={-3} y={-3}
                  width={pos.w + 6} height={pos.h + 6}
                  rx={3}
                  fill={colors.border}
                  opacity={pulseOpacity}
                />
              )}

              {/* Node background */}
              <rect
                x={0} y={0}
                width={pos.w} height={pos.h}
                rx={2}
                fill={isHovered ? colors.bg : colors.bg}
                stroke={isHovered ? '#00d4ff' : colors.border}
                strokeWidth={isHovered ? 1.5 : 1}
                opacity={node.exists ? 1 : 0.35}
                strokeDasharray={!node.exists ? '3,2' : undefined}
              />

              {/* Kind label (top, tiny) */}
              <text
                x={pos.w / 2} y={10}
                textAnchor="middle"
                fontSize={5}
                fill={node.exists ? '#555' : '#2a2a4a'}
                style={{ fontFamily: "'Press Start 2P', monospace" }}
              >
                {node.kind}
              </text>

              {/* Main label */}
              <text
                x={pos.w / 2} y={21}
                textAnchor="middle"
                fontSize={6}
                fill={node.exists ? colors.text : '#333'}
                style={{ fontFamily: "'Press Start 2P', monospace", fontWeight: 'bold' }}
              >
                {node.label}
              </text>

              {/* State dot */}
              {node.exists && (
                <circle
                  cx={pos.w - 6} cy={6}
                  r={3}
                  fill={colors.border}
                  opacity={0.9}
                />
              )}
              {!node.exists && (
                <text
                  x={pos.w / 2} y={30}
                  textAnchor="middle"
                  fontSize={5}
                  fill="#2a2a4a"
                  style={{ fontFamily: "'Press Start 2P', monospace" }}
                >
                  locked
                </text>
              )}

              {/* Hover tooltip */}
              {isHovered && node.detail && (
                <g>
                  <rect
                    x={pos.w / 2 - 60} y={pos.h + 4}
                    width={120} height={22}
                    rx={2}
                    fill="#0a0e1a"
                    stroke="#00d4ff"
                    strokeWidth={1}
                  />
                  <text
                    x={pos.w / 2} y={pos.h + 14}
                    textAnchor="middle"
                    fontSize={5}
                    fill="#ccc"
                    style={{ fontFamily: "'Press Start 2P', monospace" }}
                  >
                    {node.detail.slice(0, 24)}
                  </text>
                  {node.concept && (
                    <text
                      x={pos.w / 2} y={pos.h + 22}
                      textAnchor="middle"
                      fontSize={5}
                      fill="#00d4ff"
                      style={{ fontFamily: "'Press Start 2P', monospace" }}
                    >
                      click → learn {node.concept}
                    </text>
                  )}
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── KroGraphPanel — collapsible wrapper ─────────────────────────────────────

// jsonToYaml — simple JSON→YAML serializer (no external dep)
function jsonToYaml(obj: any, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (obj === null || obj === undefined) return 'null'
  if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj)
  if (typeof obj === 'string') {
    if (obj.includes('\n') || obj.includes('"')) return `|\n${pad}  ${obj.replace(/\n/g, `\n${pad}  `)}`
    return obj
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return obj.map(v => `\n${pad}- ${jsonToYaml(v, indent + 1)}`).join('')
  }
  const keys = Object.keys(obj).filter(k => k !== 'managedFields')
  if (keys.length === 0) return '{}'
  return keys.map(k => {
    const v = obj[k]
    const vStr = jsonToYaml(v, indent + 1)
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
      return `\n${pad}${k}:\n${pad}  ${vStr.trimStart()}`
    }
    if (Array.isArray(v) && v.length > 0) {
      return `\n${pad}${k}:${vStr}`
    }
    return `\n${pad}${k}: ${vStr}`
  }).join('')
}

interface KroGraphPanelProps {
  cr: DungeonCR
  prevCr?: DungeonCR | null
  reconciling: boolean
  onViewConcept: (id: KroConceptId) => void
}

interface DiffEntry {
  field: string
  from: string
  to: string
  note?: string
  conceptLink?: KroConceptId
}

function computeRGDDiff(prev: DungeonCR | null | undefined, curr: DungeonCR): DiffEntry[] {
  if (!prev) return []
  const diff: DiffEntry[] = []
  const ps: any = prev.spec || {}
  const cs: any = curr.spec || {}
  const pst: any = prev.status || {}
  const cst: any = curr.status || {}

  const check = (field: string, note?: string) => {
    const a = ps[field], b = cs[field]
    if (a !== b && (a !== undefined || b !== undefined)) {
      diff.push({ field, from: String(a ?? '—'), to: String(b ?? '—'), note })
    }
  }
  const checkSt = (field: string, note?: string) => {
    const a = pst[field], b = cst[field]
    if (a !== b && (a !== undefined || b !== undefined)) {
      diff.push({ field: `status.${field}`, from: String(a ?? '—'), to: String(b ?? '—'), note })
    }
  }

  check('heroHP', 'spec.heroHP')
  check('bossHP', 'spec.bossHP')
  check('heroMana', 'spec.heroMana')
  check('poisonTurns', 'spec.poisonTurns')
  check('burnTurns', 'spec.burnTurns')
  check('stunTurns', 'spec.stunTurns')
  check('weaponBonus', 'spec.weaponBonus')
  check('weaponUses', 'spec.weaponUses')
  check('armorBonus', 'spec.armorBonus')
  check('shieldBonus', 'spec.shieldBonus')
  check('helmetBonus', 'spec.helmetBonus')
  check('pantsBonus', 'spec.pantsBonus')
  check('bootsBonus', 'spec.bootsBonus')
  check('ringBonus', 'spec.ringBonus')
  check('amuletBonus', 'spec.amuletBonus')
  check('currentRoom', 'spec.currentRoom')
  check('treasureOpened', 'spec.treasureOpened')
  check('doorUnlocked', 'spec.doorUnlocked')
  check('lastLootDrop', 'spec.lastLootDrop')

  // monsterHP array — show per-index changes
  const pm: number[] = (ps.monsterHP as number[]) || []
  const cm: number[] = (cs.monsterHP as number[]) || []
  const maxM = Math.max(pm.length, cm.length)
  for (let i = 0; i < maxM; i++) {
    if ((pm[i] ?? -1) !== (cm[i] ?? -1)) {
      const killed = (pm[i] ?? 0) > 0 && (cm[i] ?? 0) === 0
      diff.push({ field: `spec.monsterHP[${i}]`, from: String(pm[i] ?? '—'), to: String(cm[i] ?? '—'), note: killed ? '→ Loot CR includeWhen fires' : undefined, conceptLink: killed ? 'includeWhen' : 'forEach' })
    }
  }

  checkSt('livingMonsters', 'kro re-aggregated from Monster CRs')
  checkSt('bossState', 'boss-graph CEL ternary')
  checkSt('bossPhase', 'boss-graph phase CEL')
  checkSt('victory', 'dungeon-graph status')
  checkSt('defeat', 'dungeon-graph status')

  // Attach concept links to status diff entries
  for (const d of diff) {
    if (!d.conceptLink) {
      if (d.field === 'status.livingMonsters') d.conceptLink = 'forEach'
      else if (d.field === 'status.bossState') d.conceptLink = 'cel-ternary'
      else if (d.field === 'status.bossPhase') d.conceptLink = 'cel-ternary'
      else if (d.field === 'status.victory' || d.field === 'status.defeat') d.conceptLink = 'status-aggregation'
      else if (d.field === 'spec.treasureOpened') d.conceptLink = 'secret-output'
      else if (d.field === 'spec.currentRoom') d.conceptLink = 'spec-mutation'
      else if (['spec.weaponBonus','spec.weaponUses','spec.armorBonus','spec.shieldBonus',
                'spec.helmetBonus','spec.pantsBonus','spec.bootsBonus','spec.ringBonus','spec.amuletBonus'].includes(d.field))
        d.conceptLink = 'spec-mutation'
    }
  }

  return diff
}

export function KroGraphPanel({ cr, prevCr, reconciling, onViewConcept }: KroGraphPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [diff, setDiff] = useState<DiffEntry[]>([])
  const [diffVisible, setDiffVisible] = useState(false)
  const diffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [inspectorNode, setInspectorNode] = useState<{id: string, kind: string, label: string} | null>(null)
  const [inspectorData, setInspectorData] = useState<any>(null)
  const [inspectorLoading, setInspectorLoading] = useState(false)

  const handleNodeSelect = useCallback(async (nodeId: string, nodeKind: string) => {
    // Static kind map: keys are node IDs from buildGraph, values are ResourceKind
    const kindMap: Record<string, ResourceKind> = {
      'dungeon': 'dungeon',
      'hero': 'hero',
      'hero-cm': 'herostate',          // Hero ConfigMap (hero-graph output)
      'boss': 'boss',
      'boss-cm': 'bossstate',          // Boss ConfigMap (boss-graph output)
      'namespace': 'namespace',
      'gameconfig-cm': 'gameconfig',   // GameConfig ConfigMap
      'treasure': 'treasure',
      'treasure-cm': 'treasurecm',
      'treasure-secret': 'treasuresecret',
      'modifier': 'modifier',
      'modifier-cm': 'modifiercm',     // Modifier state ConfigMap
      // #437: boss loot nodes
      'boss-loot': 'bossloot',
      'boss-loot-info': 'bosslootinfo',
      'boss-loot-secret': 'bosslootsecret',
      // combat-cm / action-cm are specPatch virtual nodes — no persistent K8s resource, skip
      // attack-cr / action-cr are empty RGD CRs — no managed resources, skip
    }

    // Extract index from monster-N / monster-cm-N / loot-mN / loot-info-mN / loot-secret-mN node IDs
    const monsterMatch = nodeId.match(/^monster-(\d+)$/)
    const monsterCmMatch = nodeId.match(/^monster-cm-(\d+)$/)
    const lootMatch = nodeId.match(/^loot-m(\d+)$/)
    const lootInfoMatch = nodeId.match(/^loot-info-m(\d+)$/)
    const lootSecretMatch = nodeId.match(/^loot-secret-m(\d+)$/)

    let kind: ResourceKind | undefined
    let index: number | undefined

    if (monsterMatch) {
      kind = 'monster'; index = parseInt(monsterMatch[1])
    } else if (monsterCmMatch) {
      kind = 'monsterstate'; index = parseInt(monsterCmMatch[1])
    } else if (lootMatch) {
      kind = 'loot'; index = parseInt(lootMatch[1])       // #437: Loot CR
    } else if (lootInfoMatch) {
      kind = 'lootinfo'; index = parseInt(lootInfoMatch[1])  // #437: LootInfo CM
    } else if (lootSecretMatch) {
      kind = 'lootsecret'; index = parseInt(lootSecretMatch[1])  // #437: LootSecret
    } else {
      kind = kindMap[nodeId] as ResourceKind | undefined
    }

    if (!kind) return

    const ns = cr.metadata.namespace
    const name = cr.metadata.name
    const { nodes } = buildGraph(cr, false)
    const node = nodes.find(n => n.id === nodeId)
    setInspectorNode({ id: nodeId, kind: nodeKind, label: node?.label ?? nodeId })
    setInspectorLoading(true)
    setInspectorData(null)

    try {
      const { getDungeonResource } = await import('./api')
      const data = await getDungeonResource(ns, name, kind, index)
      setInspectorData(data)
    } catch {
      setInspectorData(null)
    } finally {
      setInspectorLoading(false)
    }
  }, [cr])

  useEffect(() => {
    const entries = computeRGDDiff(prevCr, cr)
    if (entries.length > 0) {
      setDiff(entries)
      setDiffVisible(true)
      if (diffTimerRef.current) clearTimeout(diffTimerRef.current)
      diffTimerRef.current = setTimeout(() => setDiffVisible(false), 8000)
    }
  }, [cr?.spec?.attackSeq, cr?.spec?.actionSeq])

  return (
    <div className="kro-graph-panel">
      <div className="kro-graph-header" onClick={() => setCollapsed(c => !c)}>
        <span className="kro-insight-badge">kro</span>
        <span className="kro-graph-title">Resource Graph</span>
        {reconciling && <span className="kro-graph-reconciling">● reconciling</span>}
        <span className="kro-graph-toggle">{collapsed ? '▼' : '▲'}</span>
      </div>
      {!collapsed && (
        <div className="kro-graph-body">
          <div className="kro-graph-legend">
            {[
              { color: '#00ff41', label: 'alive' },
              { color: '#f5c518', label: 'ready' },
              { color: '#e94560', label: 'dead' },
              { color: '#9b59b6', label: 'defeated' },
              { color: '#00d4ff', label: 'reconciling' },
              { color: '#333', label: 'locked (includeWhen)' },
            ].map(({ color, label }) => (
              <span key={label} className="kro-legend-item">
                <span className="kro-legend-dot" style={{ background: color }} />
                <span className="kro-legend-label">{label}</span>
              </span>
            ))}
          </div>
          <div className="kro-graph-scroll">
            <KroGraph cr={cr} reconciling={reconciling} onNodeClick={onViewConcept} onNodeSelect={handleNodeSelect} />
          </div>

          {/* RGD Diff Viewer — transient before→after on every reconcile */}
          {diffVisible && diff.length > 0 && (
            <div className="kro-rgd-diff">
              <div className="kro-rgd-diff-header">
                <span className="kro-insight-badge" style={{ fontSize: 6 }}>kro</span>
                <span style={{ fontSize: 7, color: '#00d4ff', marginLeft: 6 }}>What just changed (spec patch → kro reconcile)</span>
                <button
                  onClick={() => setDiffVisible(false)}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10 }}
                >✕</button>
              </div>
              <div className="kro-rgd-diff-rows">
                {diff.map((d, i) => (
                  <div key={i} className="kro-rgd-diff-row">
                    <span className="kro-rgd-diff-field">{d.field}</span>
                    <span className="kro-rgd-diff-from">{d.from}</span>
                    <span className="kro-rgd-diff-arrow">→</span>
                    <span className="kro-rgd-diff-to">{d.to}</span>
                    {d.note && <span className="kro-rgd-diff-note">{d.note}</span>}
                    {d.conceptLink && (
                      <button
                        className="k8s-annotation-learn"
                        style={{ marginLeft: 4, fontSize: 5, padding: '1px 4px' }}
                        onClick={() => onViewConcept(d.conceptLink!)}
                      >learn →</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {inspectorNode && (
            <div className="kro-inspector">
              <div className="kro-inspector-header">
                <span className="kro-insight-badge" style={{fontSize:6}}>kro</span>
                <span className="kro-inspector-title">Inspector: {inspectorNode.label}</span>
                <code className="kro-inspector-kubectl">
                  kubectl get {inspectorNode.kind.toLowerCase().replace(' cr','')} {cr.metadata.name} -n {cr.metadata.namespace} -o yaml
                </code>
                <button
                  onClick={() => { setInspectorNode(null); setInspectorData(null) }}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 10 }}
                >✕</button>
              </div>
              <div className="kro-inspector-body">
                {inspectorLoading && <span className="kro-inspector-loading">fetching from cluster...</span>}
                {!inspectorLoading && !inspectorData && <span className="kro-inspector-empty">resource not available</span>}
                {!inspectorLoading && inspectorData && (
                  <pre className="kro-inspector-yaml">{jsonToYaml(inspectorData)}</pre>
                )}
              </div>
            </div>
          )}

          <div className="kro-graph-hint">
            Hover nodes for details · Click to learn the kro concept
          </div>
        </div>
      )}
    </div>
  )
}
