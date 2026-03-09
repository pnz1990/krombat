import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { DungeonSummary, DungeonCR, listDungeons, getDungeon, createDungeon, createNewGamePlus, submitAttack, deleteDungeon, ApiError, LeaderboardEntry, getLeaderboard } from './api'
import { useWebSocket, WSEvent } from './useWebSocket'

import { Sprite, getMonsterSprite, getMonsterName, SpriteAction, ItemSprite } from './Sprite'
import { PixelIcon } from './PixelIcon'
import {
  InsightCard, KroConceptModal, KroGlossary,
  useKroGlossary, getInsightForEvent, kroAnnotate,
  KRO_STATUS_TIPS, CelTrace, KroExpertCertificate, KroOnboardingOverlay, KRO_CONCEPTS, KroCelPlayground, type CelTraceData,
  type InsightTrigger, type KroConceptId,
} from './KroTeach'
import { KroGraphPanel } from './KroGraph'

// 8-bit styled text icons (consistent cross-platform, matches pixel font)
const ICO = {
  attack: '⚔', dice: '⊞', damage: '✦', shield: '◆', heal: '+', dagger: '†',
  skull: '☠', crown: '♛', lock: '▣', trophy: '★', gift: '◈', delete: '✕',
  help: '?', scroll: '▤', mana: '◇', poison: '●', burn: '▲', stun: '■',
  heart: '♥', gem: '♦', sword: '/', armor: '□', potion: '○',
} as const

// ─── Achievement System ───────────────────────────────────────────────────────

function computeAchievements(spec: any, maxHeroHP: number) {
  const turns = spec.attackSeq ?? 0
  const heroHP = spec.heroHP ?? 0
  const heroClass = spec.heroClass ?? 'warrior'
  const difficulty = spec.difficulty ?? 'normal'
  const weaponBonus = spec.weaponBonus ?? 0
  const equippedCount = [spec.weaponBonus, spec.armorBonus, spec.shieldBonus, spec.helmetBonus, spec.pantsBonus, spec.bootsBonus, spec.ringBonus, spec.amuletBonus].filter(v => (v ?? 0) > 0).length

  return [
    { id: 'speedrun', name: 'Speedrunner', icon: '⚡', earned: turns <= 30, desc: `Won in ${turns} turns (≤30 needed)` },
    { id: 'deathless', name: 'Untouchable', icon: '🛡', earned: heroHP >= Math.floor(maxHeroHP * 0.8), desc: `Finished with ${heroHP}/${maxHeroHP} HP (80% needed)` },
    { id: 'pacifist', name: 'Potionist', icon: '🧪', earned: weaponBonus === 0, desc: 'Won without equipping a weapon' },
    { id: 'warrior-win', name: 'War Chief', icon: '⚔', earned: heroClass === 'warrior', desc: 'Won as Warrior' },
    { id: 'mage-win', name: 'Archmage', icon: '✨', earned: heroClass === 'mage', desc: 'Won as Mage' },
    { id: 'rogue-win', name: 'Shadow', icon: '🗡', earned: heroClass === 'rogue', desc: 'Won as Rogue' },
    { id: 'hard-win', name: 'Nightmare', icon: '💀', earned: difficulty === 'hard', desc: 'Won on Hard difficulty' },
    { id: 'collector', name: 'Hoarder', icon: '🎒', earned: equippedCount >= 5, desc: `Won with ${equippedCount}/5 items equipped` },
  ]
}

function AchievementBadges({ achievements }: { achievements: ReturnType<typeof computeAchievements> }) {
  const earned = achievements.filter(a => a.earned)
  if (earned.length === 0) return null
  return (
    <div className="achievement-badges" aria-label="achievements">
      <div className="achievement-badges-label">Achievements</div>
      <div className="achievement-badges-row">
        {achievements.map(a => (
          <div key={a.id} className={`achievement-badge${a.earned ? ' earned' : ''}`} title={a.desc}
            aria-label={`achievement: ${a.name}${a.earned ? ' earned' : ''}`}>
            <span className="achievement-icon">{a.icon}</span>
            <span className="achievement-name">{a.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false)
  return (
    <div className="tooltip-wrap" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && <div className="tooltip-box">{text}</div>}
    </div>
  )
}

export default function App() {
  const { ns, name } = useParams<{ ns: string; name: string }>()
  const navigate = useNavigate()
  const selected = ns && name ? { ns, name } : null

  const [dungeons, setDungeons] = useState<DungeonSummary[]>([])
  const [detail, setDetail] = useState<DungeonCR | null>(null)
  const detailRef = useRef(detail)
  detailRef.current = detail
  const prevDetailRef = useRef<DungeonCR | null>(null)
  const [events, setEvents] = useState<WSEvent[]>([])
  const [k8sLog, setK8sLog] = useState<{ ts: string; cmd: string; res: string; yaml?: string }[]>([])
  const addK8s = (cmd: string, res: string, yaml?: string) => {
    const ts = new Date().toLocaleTimeString()
    setK8sLog(prev => [{ ts, cmd, res, yaml }, ...prev].slice(0, 50))
  }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [apiError, setApiError] = useState<string | null>(null)
  const consecutiveFailures = useRef(0)
  const [showLoot, setShowLoot] = useState(false)
  const [attackPhase, setAttackPhase] = useState<string | null>(null)
  const attackingRef = useRef(false)
  const [roomLoading, setRoomLoading] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('kroOnboardingDone'))
  const [showCheat, setShowCheat] = useState(false)
  const [deleting, setDeleting] = useState<Set<string>>(new Set())
  const [resumePrompt, setResumePrompt] = useState<{ ns: string; name: string } | null>(null)
  const resumeCheckedRef = useRef(false)
  const [lootDrop, setLootDrop] = useState<string | null>(null)
  const [attackTarget, setAttackTarget] = useState<string | null>(null)
  const [animPhase, setAnimPhase] = useState<'idle' | 'hero-attack' | 'enemy-attack' | 'item-use' | 'done'>('idle')

  // kro teaching layer
  const { unlocked, unlock } = useKroGlossary()
  const [insightQueue, setInsightQueue] = useState<InsightTrigger[]>([])
  const [kroConceptModal, setKroConceptModal] = useState<KroConceptId | null>(null)
  const shownInsightsRef = useRef<Set<KroConceptId>>(new Set())
  const [reconciling, setReconciling] = useState(false)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [showHamburger, setShowHamburger] = useState(false)

  const triggerInsight = useCallback((event: string) => {
    const trigger = getInsightForEvent(event)
    if (!trigger) return
    unlock(trigger.conceptId)
    // Only show each concept card once per session
    if (shownInsightsRef.current.has(trigger.conceptId)) return
    shownInsightsRef.current.add(trigger.conceptId)
    setInsightQueue(q => [...q, trigger])
  }, [unlock])

  // Auto-surface CEL Playground once the player is engaged (10+ concepts unlocked)
  const playgroundFiredRef = useRef(false)
  useEffect(() => {
    if (!playgroundFiredRef.current && unlocked.size >= 10) {
      playgroundFiredRef.current = true
      setTimeout(() => triggerInsight('cel-playground-unlocked'), 2000)
    }
  }, [unlocked.size, triggerInsight])

  const { connected, lastEvent } = useWebSocket(selected?.ns, selected?.name)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const refresh = useCallback(async () => {
    try {
      setDungeons(await listDungeons())
      const sel = selectedRef.current
      if (sel) {
        const d = await getDungeon(sel.ns, sel.name)
        prevDetailRef.current = detailRef.current
        setDetail(d)
      }
      consecutiveFailures.current = 0
      setApiError(null)
    } catch {
      consecutiveFailures.current += 1
      if (consecutiveFailures.current >= 3) {
        setApiError('Connection lost — retrying...')
      }
    }
  }, [])

  // Refresh on WebSocket events — only refresh data, don't add to event log
  // Update dungeon state directly from WebSocket payload (no extra HTTP request)
  // When WS is connected and delivers a DUNGEON_UPDATE, skip the redundant REST poll —
  // the payload already contains the full CR. Only fall back to refresh() when WS is
  // disconnected (connected===false) or the event is not a DUNGEON_UPDATE.
  useEffect(() => {
    if (lastEvent?.type === 'DUNGEON_UPDATE' && lastEvent.payload && selected) {
      const cr = lastEvent.payload as DungeonCR
      if (cr?.metadata?.name === selected.name) {
        prevDetailRef.current = detailRef.current
        setDetail(cr)
      }
      // WS delivered the full CR — skip redundant HTTP round-trip while connected
      if (connected) return
    }
    if (lastEvent) refresh()
  }, [lastEvent, connected])

  // Initial load + load dungeon detail when URL changes
  useEffect(() => {
    if (selected) {
      setLoading(true)
      setEvents([])
      setError('')
      // Poll until dungeon is available (kro may still be reconciling)
      let cancelled = false
      const poll = async () => {
        for (let i = 0; i < 15; i++) {
          if (cancelled) return
          try {
            const d = await getDungeon(selected.ns, selected.name)
            if (!cancelled) {
              prevDetailRef.current = detailRef.current
              setDetail(d)
              setLoading(false)
              // Teach modifier concept if this dungeon has one
              if (d.spec.modifier && d.spec.modifier !== 'none') triggerInsight('modifier-present')
              // Teach resource chaining once status is populated (Hero CR → dungeon status)
              if (d.status?.maxHeroHP) triggerInsight('resource-chaining')
              // Teach status.conditions when kro reports a genuine (non-transient) error condition
              const conditions = (d.status?.conditions as any[]) || []
              const TRANSIENT = ['cluster mutated', 'reconciliation failed', 'NotReady', 'not ready']
              if (conditions.some((c: any) =>
                (c.type === 'Error' || (c.type === 'Ready' && c.status === 'False')) &&
                c.message && !TRANSIENT.some(t => c.message.includes(t))
              )) {
                triggerInsight('status-conditions')
              }
            }
            return
          } catch {
            await new Promise(r => setTimeout(r, 2000))
          }
        }
        if (!cancelled) { setError('Dungeon not found — it may still be initializing'); setLoading(false) }
      }
      poll()
      return () => { cancelled = true }
    } else {
      setDetail(null)
      setShowLoot(false)
    }
    refresh()
  }, [ns, name, refresh])

  // On first load to the list page (no dungeon selected), check localStorage for a last-played dungeon
  useEffect(() => {
    if (selected || resumeCheckedRef.current) return
    const stored = localStorage.getItem('lastDungeon')
    if (!stored) return
    try {
      const { ns: lastNs, name: lastName } = JSON.parse(stored) as { ns: string; name: string }
      if (!lastNs || !lastName) return
      // Validate against the live dungeon list
      listDungeons().then(list => {
        const found = list.find(d => d.namespace === lastNs && d.name === lastName)
        resumeCheckedRef.current = true
        if (found) {
          setResumePrompt({ ns: lastNs, name: lastName })
        } else {
          localStorage.removeItem('lastDungeon')
        }
      }).catch(() => {
        resumeCheckedRef.current = true
      })
    } catch {
      localStorage.removeItem('lastDungeon')
      resumeCheckedRef.current = true
    }
  }, [selected])

  const handleCreate = async (name: string, monsters: number, difficulty: string, heroClass: string) => {
    setError('')
    try {
      await createDungeon(name, monsters, difficulty, heroClass, 'default')
      addK8s(`kubectl apply -f dungeon.yaml`, 'dungeon.game.k8s.example created',
        `apiVersion: game.k8s.example/v1alpha1\nkind: Dungeon\nmetadata:\n  name: ${name}\nspec:\n  monsters: ${monsters}\n  difficulty: ${difficulty}\n  heroClass: ${heroClass}`)
      triggerInsight('dungeon-created')
      triggerInsight('spec-schema')
      // forEach is always in play when creating a dungeon with multiple monsters
      if (monsters > 1) triggerInsight('forEach')
      // resourceGroup-API — fire 3s later so it doesn't compete with the first two cards
      setTimeout(() => triggerInsight('dungeon-created-2nd'), 3000)
      setTimeout(() => triggerInsight('schema-validated'), 5000)
      localStorage.setItem('lastDungeon', JSON.stringify({ ns: 'default', name }))
      navigate(`/dungeon/default/${name}`)
    } catch (e: any) { setError(e.message) }
  }

  const addEvent = (icon: string, msg: string) => {
    setEvents(prev => [{ type: 'COMBAT', action: icon, name: msg, namespace: '', payload: null }, ...prev].slice(0, 30))
  }

  const [floatingDmg, setFloatingDmg] = useState<{ target: string; amount: string; color: string } | null>(null)
  const [bossPhaseFlash, setBossPhaseFlash] = useState<'enraged' | 'berserk' | null>(null)

  const [combatModal, setCombatModal] = useState<{ phase: 'rolling' | 'resolved'; formula: string; heroAction: string; enemyAction: string; spec: any; oldHP: number } | null>(null)

  const handleAttack = async (target: string, damage: number) => {
    if (!selected || attackPhase || attackingRef.current) return
    attackingRef.current = true
    // Prevent attacking dead targets
    if (detail?.spec) {
      const mMatch = target.match(/monster-(\d+)$/)
      if (mMatch && (detail.spec.monsterHP || [])[parseInt(mMatch[1])] <= 0) { attackingRef.current = false; return }
      if (target.endsWith('-boss') && detail.spec.bossHP <= 0) { attackingRef.current = false; return }
    }
    setError('')
    const isAbility = target === 'hero' || target === 'activate-taunt'
    const isItem = target.startsWith('use-') || target.startsWith('equip-') || target === 'open-treasure' || target === 'unlock-door' || target === 'enter-room-2'
    const shortTarget = (isAbility || isItem) ? target : target.replace(/-backstab$/, '').split('-').slice(-2).join('-')
    try {
      setAttackTarget(target.replace(/-backstab$/, ''))
      setAnimPhase(isItem ? 'item-use' : 'hero-attack')
      setAttackPhase('attacking')

      if (!isAbility && !isItem) {
        setCombatModal({ phase: 'rolling', formula: detail?.status?.diceFormula || '2d12+6', heroAction: '', enemyAction: '', spec: detail?.spec, oldHP: detail?.spec.heroHP ?? 100 })
      }

      await submitAttack(selected.ns, selected.name, target, damage,
        isItem ? (detail?.spec.actionSeq ?? -1) : (detail?.spec.attackSeq ?? -1))
      setReconciling(true)
      const crKind = isItem ? 'Action' : 'Attack'
      const crField = isItem ? `action: ${target}` : `target: ${target}\n  damage: ${damage}`
      addK8s(`kubectl apply -f ${crKind.toLowerCase()}.yaml`, `${crKind.toLowerCase()}.game.k8s.example created`,
        `apiVersion: game.k8s.example/v1alpha1\nkind: ${crKind}\nmetadata:\n  name: ${selected.name}-${target}-${Date.now() % 100000}\nspec:\n  dungeonName: ${selected.name}\n  dungeonNamespace: ${selected.ns}\n  ${crField}`)
      // Teach: Attack CR = empty RGD pattern; first combat attack = CEL basics; externalRef watch loop
      if (!isItem && !isAbility) {
        triggerInsight('attack-cr')
        triggerInsight('externalRef')
      }

      let updated = detail!

      if (isItem) {
        // Items: poll until the specific field changes
        const checkField = (d: any) => {
          if (target === 'open-treasure') return d.spec.treasureOpened
          if (target === 'unlock-door') return d.spec.doorUnlocked
          if (target === 'enter-room-2') return d.spec.currentRoom
          if (target.startsWith('equip-weapon')) return d.spec.weaponBonus
          if (target.startsWith('equip-armor')) return d.spec.armorBonus
          if (target.startsWith('equip-shield')) return d.spec.shieldBonus
          if (target.startsWith('equip-helmet')) return d.spec.helmetBonus
          if (target.startsWith('equip-pants')) return d.spec.pantsBonus
          if (target.startsWith('equip-boots')) return d.spec.bootsBonus
          if (target.startsWith('equip-ring')) return d.spec.ringBonus
          if (target.startsWith('equip-amulet')) return d.spec.amuletBonus
          return d.spec.lastHeroAction
        }
        const prevVal = checkField(detail)
        if (target === 'enter-room-2') setRoomLoading(true)
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(r => setTimeout(r, 1500))
          const current = await getDungeon(selected.ns, selected.name)
          if (checkField(current) !== prevVal) {
            updated = current
            break
          }
        }
        setDetail(updated)
        setRoomLoading(false)
        setReconciling(false)
        setAttackPhase(null)
        setAnimPhase('idle')
        setAttackTarget(null)
        attackingRef.current = false
        // Teach specific item/room events
        if (target === 'enter-room-2') triggerInsight('enter-room-2')
        if (target === 'open-treasure') triggerInsight('treasure-opened')
        if (target.startsWith('equip-boots')) triggerInsight('boots-equipped')
        return // Items done — don't fall through to combat/loot logic
      } else {
        // Combat: backend is synchronous — attackSeq increments before API returns.
        // Capture prevSeq from the pre-attack state (detail), not after a wait.
        const oldHP = detail?.spec.heroHP ?? 100
        const formula = detail?.status?.diceFormula || '2d12+6'
        const prevSeq = detail?.spec.attackSeq || 0

        if (!isAbility) {
          setCombatModal({ phase: 'rolling', formula, heroAction: '', enemyAction: '', spec: detail?.spec, oldHP })
        }

        // Poll until attackSeq > prevSeq (should resolve on first or second attempt)
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(r => setTimeout(r, 1000))
          const current = await getDungeon(selected.ns, selected.name)
          if ((current.spec.attackSeq || 0) > prevSeq) {
            updated = current
            addK8s(`kubectl get dungeon ${selected.name}`, `heroHP:${current.spec.heroHP} bossHP:${current.spec.bossHP}`,
              JSON.stringify({ spec: current.spec, status: current.status }, null, 2))
            break
          }
          await new Promise(r => setTimeout(r, 3000))
        }
        setDetail(updated)
        setReconciling(false)
      }

      const heroAction = updated.spec.lastHeroAction || ''
      const enemyAction = updated.spec.lastEnemyAction || ''
      const pollSucceeded = updated !== detail

      if (!isAbility && !isItem) {
        const displayHero = pollSucceeded ? heroAction : 'Attack processing... (dismiss and check game state)'
        const displayEnemy = pollSucceeded ? enemyAction : ''
        setCombatModal({ phase: 'resolved', formula: detail?.status?.diceFormula || '2d12+6', heroAction: displayHero, enemyAction: displayEnemy, spec: updated.spec, oldHP: detail?.spec.heroHP ?? 100 })
        setAnimPhase('enemy-attack')
      } else if (!isItem) {
        // Ability (heal/taunt)
        const healMatch = heroAction.match(/heals for (\d+)/)
        if (healMatch) setCombatModal({ phase: 'resolved', formula: '', heroAction, enemyAction: 'No counter-attack during ability', spec: updated.spec, oldHP: detail?.spec.heroHP ?? 100 })
        else setCombatModal({ phase: 'resolved', formula: '', heroAction, enemyAction, spec: updated.spec, oldHP: detail?.spec.heroHP ?? 100 })
      }

      // Loot drop — only check on combat actions (not items/equip)
      if (!isItem && pollSucceeded && updated.spec.lastLootDrop) {
        setLootDrop(updated.spec.lastLootDrop)
        triggerInsight('loot-drop')
        setTimeout(() => triggerInsight('loot-drop-string-ops'), 4000)
      }
      await new Promise(r => setTimeout(r, 100))

      // Read combat log from Dungeon CR — skip "already dead" non-events
      if (pollSucceeded && heroAction && !heroAction.includes('already dead') && !heroAction.includes('already defeated')) {
        const icon = heroAction.includes('heals') ? '💚' : heroAction.includes('Taunt') ? '🛡️' : heroAction.includes('Backstab') ? '🗡️' : heroAction.includes('STUNNED') ? '🟡' : '⚔️'
        // Try to parse rich combat log
        let logParsed: any = null
        try { logParsed = JSON.parse(updated.spec.lastCombatLog || '{}') } catch {}
        if (logParsed?.seq) {
          const parts = [heroAction]
          if (logParsed.modifier && logParsed.modifier !== 'none') parts.push(`[${logParsed.modifier}]`)
          if (logParsed.weaponBonus > 0) parts.push(`[+${logParsed.weaponBonus} wpn, ${logParsed.weaponUses} uses left]`)
          if (logParsed.armorBonus > 0) parts.push(`[${logParsed.armorBonus}% armor]`)
          if (logParsed.shieldBonus > 0) parts.push(`[${logParsed.shieldBonus}% shield]`)
          if (logParsed.tauntActive > 0) parts.push(`[taunt active]`)
          if (logParsed.poison > 0) parts.push(`[poison ${logParsed.poison}t]`)
          if (logParsed.burn > 0) parts.push(`[burn ${logParsed.burn}t]`)
          if (logParsed.stun > 0) parts.push(`[stun ${logParsed.stun}t]`)
          if (logParsed.notes) parts.push(logParsed.notes)
          addEvent(icon, parts.join(' '))
        } else {
          addEvent(icon, heroAction)
        }
        if (heroAction.includes('Dropped')) addEvent('🎁', heroAction.split('Dropped')[1]?.trim() || 'Loot dropped!')
        // Kill
        if (heroAction.includes('-> 0)')) {
          const target = heroAction.match(/damage to (\S+)/)?.[1] || 'enemy'
          addEvent('💀', `${target} slain!`)
        }
      }
      if (pollSucceeded && enemyAction) {
        const eIcon = enemyAction.includes('POISON') ? '🟢' : enemyAction.includes('BURN') ? '🔴' : enemyAction.includes('STUN') ? '🟡' : enemyAction.includes('defeated') ? '👑' : '💀'
        addEvent(eIcon, enemyAction)
      }
      // State change events (only if poll succeeded and state actually changed)
      if (pollSucceeded) {
        const prevBossHP = detail?.spec.bossHP ?? 1
        const newBossHP = updated.spec.bossHP ?? 1
        const prevAllDead = (detail?.spec.monsterHP || []).every((hp: number) => hp <= 0)
        const nowAllDead = (updated.spec.monsterHP || []).every((hp: number) => hp <= 0)
        if (nowAllDead && !prevAllDead) { addEvent('🐉', 'Boss unlocked! All monsters slain!'); triggerInsight('boss-ready'); triggerInsight('all-monsters-dead') }
        if (newBossHP <= 0 && prevBossHP > 0) { addEvent('🏆', 'VICTORY! Boss defeated!'); triggerInsight('boss-killed') }
        // Boss phase transitions
        const prevMaxBossHP = Number(detail?.status?.maxBossHP) || (prevBossHP > 0 ? prevBossHP : 1)
        const newMaxBossHP = Number(updated.status?.maxBossHP) || prevMaxBossHP
        const prevPct = newMaxBossHP > 0 ? (prevBossHP / newMaxBossHP) * 100 : 100
        const newPct = newMaxBossHP > 0 ? (newBossHP / newMaxBossHP) * 100 : 100
        if (prevPct > 50 && newPct <= 50 && newBossHP > 0) {
          addEvent('🔥', '⚠️ The boss becomes ENRAGED! (Phase 2: ×1.5 damage)')
          setBossPhaseFlash('enraged')
          setTimeout(() => setBossPhaseFlash(null), 1500)
        }
        if (prevPct > 25 && newPct <= 25 && newBossHP > 0) {
          addEvent('💀', '💀 BERSERK MODE! Boss attacks with fury! (Phase 3: ×2.0 damage)')
          setBossPhaseFlash('berserk')
          setTimeout(() => setBossPhaseFlash(null), 1500)
        }
        if ((updated.spec.heroHP ?? 100) <= 0 && (detail?.spec.heroHP ?? 100) > 0) addEvent('💀', 'Hero has fallen...')
        // DoT floating damage on hero
        const prevHeroHP = detail?.spec.heroHP ?? 100
        const newHeroHP = updated.spec.heroHP ?? 100
        const hpDropped = newHeroHP < prevHeroHP
        const poisonActive = (detail?.spec.poisonTurns ?? 0) > 0
        const burnActive = (detail?.spec.burnTurns ?? 0) > 0
        if (hpDropped && (poisonActive || burnActive)) {
          const dotDmg = prevHeroHP - newHeroHP
          // Only show DoT float if the drop is consistent with DoT amounts
          if (dotDmg === 5 || dotDmg === 8 || (dotDmg > 0 && dotDmg <= 13)) {
            const color = poisonActive ? '#2ecc71' : '#e74c3c'
            setFloatingDmg({ target: 'hero', amount: `-${dotDmg}`, color })
            setTimeout(() => setFloatingDmg(null), 1200)
          }
        }
        // Detect monster kill
        const prevDeadCount = (detail?.spec.monsterHP || []).filter((hp: number) => hp <= 0).length
        const newDeadCount = (updated.spec.monsterHP || []).filter((hp: number) => hp <= 0).length
        if (newDeadCount > prevDeadCount) triggerInsight('monster-killed')
        // First attack
        if ((detail?.spec.attackSeq ?? 0) === 0 && (updated.spec.attackSeq ?? 0) > 0) triggerInsight('first-attack')
        // Second attack — teach the reconcile loop concept
        if ((detail?.spec.attackSeq ?? 0) === 1 && (updated.spec.attackSeq ?? 0) > 1) triggerInsight('second-attack')
      }

      // Don't clear attackPhase/attackTarget — user must dismiss combat modal
    } catch (e: any) {
      // 409 Conflict: another concurrent request already advanced the dungeon
      // state. Re-fetch the latest state so the player sees current HP/seq,
      // then show a non-blocking notice so they can retry.
      if (e instanceof ApiError && e.status === 409) {
        try {
          const refreshed = await getDungeon(selected!.ns, selected!.name)
          setDetail(refreshed)
        } catch { /* best-effort */ }
        setError('State changed — dungeon refreshed. Please retry your action.')
      } else {
        setError(e.message)
      }
      setCombatModal(null)
      setAttackPhase(null)
      setReconciling(false)
      setAnimPhase('idle')
      setAttackTarget(null)
      setFloatingDmg(null)
      attackingRef.current = false
    }
  }

  const dismissCombat = () => {
    setCombatModal(null)
    setAttackPhase(null)
    setAnimPhase('idle')
    setAttackTarget(null)
    attackingRef.current = false
  }

  const handleSelect = (ns: string, name: string) => {
    localStorage.setItem('lastDungeon', JSON.stringify({ ns, name }))
    navigate(`/dungeon/${ns}/${name}`)
  }

  const handleDelete = async (ns?: string, name?: string) => {
    const delNs = ns || selected?.ns
    const delName = name || selected?.name
    if (!delNs || !delName) return
    if (!confirm(`Delete dungeon "${delName}"? This cannot be undone.`)) return
    setDeleting(prev => new Set(prev).add(delName))
    try {
      await deleteDungeon(delNs, delName)
      triggerInsight('dungeon-deleted')
      if (selected?.name === delName) navigate('/')
      // Clear last dungeon from localStorage if it was the deleted one
      try {
        const stored = localStorage.getItem('lastDungeon')
        if (stored) {
          const { ns: lastNs, name: lastName } = JSON.parse(stored)
          if (lastNs === delNs && lastName === delName) localStorage.removeItem('lastDungeon')
        }
      } catch { /* ignore */ }
      // Keep in list with "deleting" visual — backend filters DELETING CRs on next refresh
      // Exponential backoff: start at 1s, double each attempt, cap at 10s (max ~30 attempts)
      const poll = async () => {
        let delay = 1000
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, delay))
          delay = Math.min(delay * 2, 10000)
          const list = await listDungeons()
          setDungeons(list)
          if (!list.find(d => d.name === delName)) break
        }
        setDeleting(prev => { const s = new Set(prev); s.delete(delName); return s })
      }
      poll() // fire and forget — don't block UI
    } catch (e: any) { setError(e.message); setDeleting(prev => { const s = new Set(prev); s.delete(delName); return s }) }
  }

  const handleOpenLeaderboard = async () => {
    setShowLeaderboard(true)
    setLeaderboardLoading(true)
    try {
      const entries = await getLeaderboard()
      setLeaderboard(entries)
    } catch {
      setLeaderboard([])
    } finally {
      setLeaderboardLoading(false)
    }
  }

  const handleNewGamePlus = async () => {
    if (!detail) return
    const spec = detail.spec
    const runCount = (spec.runCount ?? 0) + 1
    // Generate a new dungeon name: append or increment run suffix
    const baseName = selected?.name?.replace(/-ng\d+$/, '') ?? 'dungeon'
    const newName = `${baseName}-ng${runCount}`
    const ns = selected?.ns ?? 'default'
    if (!confirm(`Start New Game+ (Run #${runCount}) as "${newName}"?\nEnemies are 25% stronger per run. Gear carries over!`)) return
    try {
      await createNewGamePlus(newName, spec.monsters ?? 3, spec.difficulty ?? 'normal', spec.heroClass ?? 'warrior', {
        runCount,
        weaponBonus: spec.weaponBonus,
        weaponUses: spec.weaponUses,
        armorBonus: spec.armorBonus,
        shieldBonus: spec.shieldBonus,
        helmetBonus: spec.helmetBonus,
        pantsBonus: spec.pantsBonus,
        bootsBonus: spec.bootsBonus,
        ringBonus: spec.ringBonus,
        amuletBonus: spec.amuletBonus,
      }, ns)
      navigate(`/dungeon/${ns}/${newName}`)
    } catch (e: any) { setError(e.message) }
  }

  return (
    <div className="app">
      <header className="header">
        <img src="/logo.png" alt="Kubernetes RPG" className="logo" />
        <p>Powered by kro ResourceGraphDefinitions on EKS</p>
        {selected && (
          <p style={{ fontSize: '7px', marginTop: 4, color: connected ? '#00ff41' : '#e94560' }}>
            {connected ? '● CONNECTED' : '○ DISCONNECTED'}
          </p>
        )}
      </header>

      {error && <div className="card" style={{ borderColor: '#e94560', color: '#e94560', fontSize: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{error}</span>
        <button aria-label="Dismiss error" onClick={() => setError('')} style={{ background: 'none', border: 'none', color: '#e94560', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px' }}>✕</button>
      </div>}

      {!selected ? (
        <>
          {showOnboarding && <KroOnboardingOverlay onDismiss={() => setShowOnboarding(false)} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <div style={{ position: 'relative' }}>
              <button className="hamburger-btn" aria-label="Menu" onClick={() => setShowHamburger(v => !v)}>☰</button>
              {showHamburger && (
                <div className="hamburger-menu" onMouseLeave={() => setShowHamburger(false)}>
                  <button className="hamburger-item" onClick={() => { setShowHamburger(false); handleOpenLeaderboard() }}>Leaderboard</button>
                </div>
              )}
            </div>
          </div>
          <CreateForm onCreate={handleCreate} />
          {resumePrompt && (
            <div className="card" style={{ borderColor: '#f5c518', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
              <span style={{ fontSize: '8px', color: '#f5c518' }}>Resume last dungeon: <strong>{resumePrompt.name}</strong>?</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-gold" style={{ fontSize: '7px', padding: '3px 8px' }} onClick={() => { setResumePrompt(null); handleSelect(resumePrompt.ns, resumePrompt.name) }}>Resume</button>
                <button aria-label="Dismiss resume prompt" style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px' }} onClick={() => setResumePrompt(null)}>✕</button>
              </div>
            </div>
          )}
          <DungeonList dungeons={dungeons} onSelect={handleSelect} onDelete={handleDelete} deleting={deleting} lastDungeon={resumePrompt ?? undefined} />
        </>
      ) : loading ? (
        <div className="loading">Initializing dungeon</div>
      ) : detail ? (
        <DungeonView
          cr={detail}
          prevCr={prevDetailRef.current}
          onBack={() => { navigate('/'); refresh() }}
          onNewGamePlus={handleNewGamePlus}
          onAttack={handleAttack}
          attackPhase={attackPhase}
          roomLoading={roomLoading}
          animPhase={animPhase}
          attackTarget={attackTarget}
          floatingDmg={floatingDmg}
          bossPhaseFlash={bossPhaseFlash}
          combatModal={combatModal}
          onDismissCombat={dismissCombat}
          lootDrop={lootDrop}
          onDismissLoot={() => setLootDrop(null)}
          events={events}
          k8sLog={k8sLog}
          showLoot={showLoot}
          onOpenLoot={() => setShowLoot(true)}
          onCloseLoot={() => setShowLoot(false)}
          showHelp={showHelp}
          onToggleHelp={() => setShowHelp(h => !h)}
          showCheat={showCheat}
          onToggleCheat={() => setShowCheat(c => !c)}
          wsConnected={connected}
          apiError={apiError}
          kroUnlocked={unlocked}
          onViewKroConcept={setKroConceptModal}
          reconciling={reconciling}
          onOpenLeaderboard={handleOpenLeaderboard}
        />
      ) : null}

      {/* kro Insight Cards — slide in from bottom-right */}
      {insightQueue.length > 0 && (
        <InsightCard
          trigger={insightQueue[0]}
          onDismiss={() => setInsightQueue(q => q.slice(1))}
          onViewConcept={setKroConceptModal}
        />
      )}

      {/* Leaderboard — rendered globally so it works from any screen */}
      {showLeaderboard && (
        <LeaderboardPanel entries={leaderboard} loading={leaderboardLoading} onClose={() => setShowLeaderboard(false)} />
      )}

      {/* kro Concept Modal */}
      {kroConceptModal && (
        <KroConceptModal conceptId={kroConceptModal} onClose={() => setKroConceptModal(null)} />
      )}
    </div>
  )
}

function CreateForm({ onCreate }: { onCreate: (n: string, m: number, d: string, c: string) => void }) {
  const [name, setName] = useState('')
  const [monsters, setMonsters] = useState(3)
  const [difficulty, setDifficulty] = useState('normal')
  const [heroClass, setHeroClass] = useState('warrior')
  const dnsLabelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
  const nameValid = name === '' || dnsLabelRegex.test(name)
  const canCreate = name.length > 0 && dnsLabelRegex.test(name)
  return (
    <div className="create-form">
      <div>
        <label>Dungeon Name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="my-dungeon"
          maxLength={63}
          pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
        />
        {!nameValid && <div className="input-error">Lowercase letters, numbers, hyphens only. Max 63 chars. Must start and end with alphanumeric.</div>}
      </div>
      <div><label>Monsters</label><input type="number" min={1} max={10} value={monsters} onChange={e => setMonsters(+e.target.value)} /></div>
      <div><label>Difficulty</label>
        <select value={difficulty} onChange={e => setDifficulty(e.target.value)}>
          <option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option>
        </select>
      </div>
      <div><label>Hero Class</label>
        <select value={heroClass} onChange={e => setHeroClass(e.target.value)}>
          <option value="warrior">⚔️ Warrior</option><option value="mage">🔮 Mage</option><option value="rogue">🗡️ Rogue</option>
        </select>
      </div>
      <button className="btn btn-gold" disabled={!canCreate} onClick={() => { if (canCreate) { onCreate(name, monsters, difficulty, heroClass); setName('') } }}>
        Create Dungeon
      </button>
    </div>
  )
}

function DungeonList({ dungeons, onSelect, onDelete, deleting, lastDungeon }: {
  dungeons: DungeonSummary[]; onSelect: (ns: string, name: string) => void
  onDelete: (ns: string, name: string) => void; deleting: Set<string>
  lastDungeon?: { ns: string; name: string }
}) {
  return (
    <div className="dungeon-list">
      {!dungeons.length && <div className="loading">No dungeons yet — create one above</div>}
      {dungeons.map(d => {
        const isLast = lastDungeon && lastDungeon.ns === d.namespace && lastDungeon.name === d.name
        return (
        <div key={d.name} className={`dungeon-tile${deleting.has(d.name) ? ' deleting' : ''}${isLast ? ' last-played' : ''}`} onClick={() => onSelect(d.namespace, d.name)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>{d.victory ? '' : ''}{d.name}</h3>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {isLast && <span className="last-played-badge">LAST PLAYED</span>}
              {deleting.has(d.name) ? (
                <span style={{ fontSize: '7px', color: 'var(--accent)' }}>Deleting...</span>
              ) : (
                <button className="tile-delete-btn" aria-label={`Delete dungeon ${d.name}`} title="Delete dungeon" onClick={e => { e.stopPropagation(); onDelete(d.namespace, d.name) }}><PixelIcon name="damage" size={12} /></button>
              )}
            </div>
          </div>
          <div className="stats">
            <span className={`tag tag-${d.difficulty}`}>{d.difficulty}</span>
            {d.runCount != null && d.runCount > 0 && (
              <span className="tag ng-plus-badge" title={`New Game+ run #${d.runCount}`}>⭐ NG+{d.runCount}</span>
            )}
            <span>Monsters: {d.livingMonsters ?? '?'}</span>
            <span>Boss: {d.bossState === 'pending' ? 'Locked' : d.bossState === 'ready' ? 'Ready' : d.bossState === 'defeated' ? 'Defeated' : d.bossState ?? '?'}</span>
            {d.modifier && d.modifier !== 'none' && (
              <span className={`tag tag-modifier-${d.modifier.startsWith('curse') ? 'curse' : 'blessing'}`} title={d.modifier}>
                {d.modifier.startsWith('curse') ? '⚠' : '✦'} {d.modifier.replace(/^(curse|blessing)-/, '')}
              </span>
            )}
            {d.victory && <span className="victory">VICTORY!</span>}
            {!d.victory && <span style={{ color: 'var(--green)' }}>In Progress</span>}
          </div>
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: '7px', color: 'var(--text-dim)', background: 'rgba(255,255,255,0.05)', border: '1px solid #333', borderRadius: 2, padding: '1px 4px' }}>ns: {d.namespace}</span>
          </div>
        </div>
        )
      })}
    </div>
  )
}

const OUTCOME_ICON: Record<string, string> = {
  victory: 'VICTORY',
  defeat: 'DEFEAT',
  'room1-cleared': 'ROOM 1',
  'in-progress': '...',
}
const OUTCOME_COLOR: Record<string, string> = {
  victory: '#f5c518',
  defeat: '#e94560',
  'room1-cleared': '#00ff41',
  'in-progress': '#888',
}
const CLASS_ICON: Record<string, string> = { warrior: '⚔️', mage: '🔮', rogue: '🗡️' }

function LeaderboardPanel({ entries, loading, onClose }: {
  entries: LeaderboardEntry[]; loading: boolean; onClose: () => void
}) {
  return (
    <div className="leaderboard-overlay" role="dialog" aria-label="Leaderboard">
      <div className="leaderboard-panel">
        <div className="leaderboard-header">
          <span className="leaderboard-title">Leaderboard — Top Runs</span>
          <button className="modal-close leaderboard-close" aria-label="Close leaderboard" onClick={onClose}>✕</button>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 16, fontSize: '8px', color: 'var(--text-dim)' }}>Loading...</div>
        ) : entries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 16, fontSize: '8px', color: 'var(--text-dim)' }}>
            No runs recorded yet. Complete a dungeon to appear here!
          </div>
        ) : (
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Dungeon</th>
                <th>Class</th>
                <th>Difficulty</th>
                <th>Outcome</th>
                <th>Turns</th>
                <th>Room</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.timestamp}-${e.dungeonName}`} className={`lb-row lb-${e.outcome}`}>
                  <td className="lb-rank">{i + 1}</td>
                  <td className="lb-name">{e.dungeonName}</td>
                  <td>{CLASS_ICON[e.heroClass] ?? e.heroClass}</td>
                  <td><span className={`tag tag-${e.difficulty}`}>{e.difficulty}</span></td>
                  <td style={{ color: OUTCOME_COLOR[e.outcome] ?? '#888', fontWeight: 'bold' }}>
                    {OUTCOME_ICON[e.outcome] ?? e.outcome}
                  </td>
                  <td className="lb-turns">{e.totalTurns}</td>
                  <td>{e.currentRoom ?? 1}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: '7px', color: 'var(--text-dim)', marginTop: 8, textAlign: 'center' }}>
          Sorted by fewest turns. Stored in the <code>krombat-leaderboard</code> ConfigMap in <code>rpg-system</code>.
        </div>
      </div>
    </div>
  )
}




function DungeonBats() {
  const [bats, setBats] = useState<{ id: number; startX: number; startY: number; endX: number; endY: number; dur: number; delay: number }[]>([])
  const nextId = useRef(0)
  useEffect(() => {
    const spawn = () => {
      // 40% chance to spawn a bat every 3-6 seconds
      if (Math.random() < 0.4) {
        const fromLeft = Math.random() > 0.5
        setBats(prev => [...prev, {
          id: nextId.current++,
          startX: fromLeft ? -5 : 105,
          startY: 10 + Math.random() * 40,
          endX: fromLeft ? 105 : -5,
          endY: 10 + Math.random() * 40,
          dur: 3 + Math.random() * 3,
          delay: 0,
        }].slice(-3)) // max 3 bats at once
      }
    }
    const id = setInterval(spawn, 3000 + Math.random() * 3000)
    return () => clearInterval(id)
  }, [])

  return <>
    {bats.map(b => <FlyingBat key={b.id} {...b} onDone={() => setBats(prev => prev.filter(x => x.id !== b.id))} />)}
  </>
}

function FlyingBat({ startX, startY, endX, endY, dur, onDone }: { startX: number; startY: number; endX: number; endY: number; dur: number; delay: number; onDone: () => void }) {
  const [frame, setFrame] = useState(1)
  const [pos, setPos] = useState({ x: startX, y: startY })
  const startTime = useRef(Date.now())

  useEffect(() => {
    let tick = 0
    const id = setInterval(() => {
      // Update position every tick (50ms)
      const elapsed = (Date.now() - startTime.current) / 1000
      const t = Math.min(elapsed / dur, 1)
      setPos({ x: startX + (endX - startX) * t, y: startY + (endY - startY) * t + Math.sin(t * Math.PI * 4) * 5 })
      if (t >= 1) { onDone(); return }
      // Update animation frame every 3 ticks (150ms)
      tick++
      if (tick % 3 === 0) setFrame(f => (f % 3) + 1)
    }, 50)
    return () => clearInterval(id)
  }, [])

  return (
    <img src={`/sprites/dungeon/bat-${frame}.png`} alt="" className="flying-bat"
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: `translate(-50%,-50%) scaleX(${endX > startX ? 1 : -1})` }} />
  )
}
function EventLogTabs({ events, k8sLog, kroUnlocked, onViewKroConcept, dungeonNs, dungeonName, showPlayground, onOpenPlayground, onClosePlayground }: {
  events: WSEvent[]
  k8sLog: { ts: string; cmd: string; res: string; yaml?: string }[]
  kroUnlocked: Set<KroConceptId>
  onViewKroConcept: (id: KroConceptId) => void
  dungeonNs?: string
  dungeonName?: string
  showPlayground: boolean
  onOpenPlayground: () => void
  onClosePlayground: () => void
}) {
  const [tab, setTab] = useState<'game' | 'k8s' | 'kro'>('game')
  const [yamlModal, setYamlModal] = useState<{ yaml: string; cmd: string } | null>(null)
  const [kroConceptModal, setKroConceptModal] = useState<KroConceptId | null>(null)
  return (
    <div style={{ marginTop: 16 }}>
      <div className="log-tabs">
        <button className={`log-tab${tab === 'game' ? ' active' : ''}`} onClick={() => setTab('game')}>Game Log</button>
        <button className={`log-tab${tab === 'k8s' ? ' active' : ''}`} onClick={() => setTab('k8s')}>K8s Log</button>
        <button className={`log-tab kro-tab${tab === 'kro' ? ' active' : ''}`} onClick={() => setTab('kro')}>
          kro ({kroUnlocked.size}/{Object.keys(KRO_CONCEPTS).length})
        </button>
      </div>

      {/* YAML + kro annotation modal */}
      {yamlModal && (
        <div className="modal-overlay" onClick={() => setYamlModal(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="YAML viewer" onClick={e => e.stopPropagation()} style={{ maxWidth: 520, textAlign: 'left' }}>
            <pre className="yaml-view">{yamlModal.yaml}</pre>
            {(() => {
              const ann = kroAnnotate(yamlModal.cmd, yamlModal.yaml)
              if (!ann) return null
              return (
                <div className="k8s-annotation">
                  <div className="k8s-annotation-label">kro — what happened</div>
                  <div className="k8s-annotation-what">{ann.what}</div>
                  <div className="k8s-annotation-rgd">RGD: {ann.rgd}</div>
                  {ann.cel && <pre className="k8s-annotation-cel">{ann.cel}</pre>}
                  <button className="k8s-annotation-learn" onClick={() => { setYamlModal(null); onViewKroConcept(ann.concept) }}>
                    Learn: {ann.concept} →
                  </button>
                </div>
              )
            })()}
            <button className="btn btn-gold" style={{ marginTop: 8 }} onClick={() => setYamlModal(null)}>Close</button>
          </div>
        </div>
      )}

      {/* kro concept modal opened from glossary */}
      {kroConceptModal && (
        <KroConceptModal conceptId={kroConceptModal} onClose={() => setKroConceptModal(null)} />
      )}

      {/* CEL Playground modal */}
      {showPlayground && dungeonNs && dungeonName && (
        <KroCelPlayground
          dungeonNs={dungeonNs}
          dungeonName={dungeonName}
          onLearnConcept={id => { setKroConceptModal(id); onClosePlayground() }}
          onClose={onClosePlayground}
        />
      )}

      {tab === 'game' ? (
        <div className="event-log" aria-live="polite" aria-atomic="false" aria-label="Game event log">
          {events.length === 0 && <div className="event-entry">Waiting for events...</div>}
          {events.map((e, i) => (
            <div key={i} className="event-entry">
              <span className="event-icon">{e.action}</span>
              <span className="event-msg">{e.name}</span>
            </div>
          ))}
        </div>
      ) : tab === 'k8s' ? (
        <div className="event-log k8s-log">
          {k8sLog.length === 0 && <div className="event-entry">No K8s operations yet...</div>}
          {k8sLog.map((e, i) => (
            <div key={i} className={`k8s-entry${e.yaml ? ' clickable' : ''}`} onClick={() => e.yaml && setYamlModal({ yaml: e.yaml, cmd: e.cmd })}>
              <span className="k8s-ts">{e.ts}</span>
              <span className="k8s-cmd">$ {e.cmd}</span>
              <span className="k8s-res">{e.res}</span>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <KroGlossary unlocked={kroUnlocked} onViewConcept={id => setKroConceptModal(id)} />
        </div>
      )}
    </div>
  )
}

function CheatModal({ onClose, onAction }: { onClose: () => void; onAction: (target: string) => void }) {
  const sections = [
    { title: 'Weapons', items: [
      { id: 'equip-weapon-common', label: 'Common Sword', sprite: 'weapon-common' },
      { id: 'equip-weapon-rare', label: 'Rare Sword', sprite: 'weapon-rare' },
      { id: 'equip-weapon-epic', label: 'Epic Sword', sprite: 'weapon-epic' },
    ]},
    { title: 'Armor', items: [
      { id: 'equip-armor-common', label: 'Common Armor', sprite: 'armor-common' },
      { id: 'equip-armor-rare', label: 'Rare Armor', sprite: 'armor-rare' },
      { id: 'equip-armor-epic', label: 'Epic Armor', sprite: 'armor-epic' },
    ]},
    { title: 'Shields', items: [
      { id: 'equip-shield-common', label: 'Common Shield', sprite: 'shield-common' },
      { id: 'equip-shield-rare', label: 'Rare Shield', sprite: 'shield-rare' },
      { id: 'equip-shield-epic', label: 'Epic Shield', sprite: 'shield-epic' },
    ]},
    { title: 'Helmets', items: [
      { id: 'equip-helmet-common', label: 'Common Helmet', sprite: 'helmet-common' },
      { id: 'equip-helmet-rare', label: 'Rare Helmet', sprite: 'helmet-rare' },
      { id: 'equip-helmet-epic', label: 'Epic Helmet', sprite: 'helmet-epic' },
    ]},
    { title: 'Pants', items: [
      { id: 'equip-pants-common', label: 'Common Pants', sprite: 'pants-common' },
      { id: 'equip-pants-rare', label: 'Rare Pants', sprite: 'pants-rare' },
      { id: 'equip-pants-epic', label: 'Epic Pants', sprite: 'pants-epic' },
    ]},
    { title: 'Boots', items: [
      { id: 'equip-boots-common', label: 'Common Boots', sprite: 'boots-common' },
      { id: 'equip-boots-rare', label: 'Rare Boots', sprite: 'boots-rare' },
      { id: 'equip-boots-epic', label: 'Epic Boots', sprite: 'boots-epic' },
    ]},
    { title: 'Rings', items: [
      { id: 'equip-ring-common', label: 'Common Ring', sprite: 'ring-common' },
      { id: 'equip-ring-rare', label: 'Rare Ring', sprite: 'ring-rare' },
      { id: 'equip-ring-epic', label: 'Epic Ring', sprite: 'ring-epic' },
    ]},
    { title: 'Amulets', items: [
      { id: 'equip-amulet-common', label: 'Common Amulet', sprite: 'amulet-common' },
      { id: 'equip-amulet-rare', label: 'Rare Amulet', sprite: 'amulet-rare' },
      { id: 'equip-amulet-epic', label: 'Epic Amulet', sprite: 'amulet-epic' },
    ]},
    { title: 'HP Potions', items: [
      { id: 'use-hppotion-common', label: '+20 HP', sprite: 'hppotion-common' },
      { id: 'use-hppotion-rare', label: '+40 HP', sprite: 'hppotion-rare' },
      { id: 'use-hppotion-epic', label: 'Full HP', sprite: 'hppotion-epic' },
    ]},
    { title: 'Mana Potions', items: [
      { id: 'use-manapotion-common', label: '+2 Mana', sprite: 'manapotion-common' },
      { id: 'use-manapotion-rare', label: '+3 Mana', sprite: 'manapotion-rare' },
      { id: 'use-manapotion-epic', label: '+8 Mana', sprite: 'manapotion-epic' },
    ]},
  ]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" role="dialog" aria-modal="true" aria-label="Cheat mode" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <h2 style={{ color: '#e94560', fontSize: 12, marginBottom: 8 }}>🔧 CHEAT MODE</h2>
        <p style={{ fontSize: 7, color: '#666', marginBottom: 12 }}>Items are added to inventory then used/equipped via Attack CR pipeline.</p>
        {sections.map(s => (
          <div key={s.title} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 8, color: '#888', marginBottom: 4 }}>{s.title}</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {s.items.map(item => (
                <button key={item.id} className="backpack-slot" style={{ borderColor: item.sprite.includes('epic') ? '#9b59b6' : item.sprite.includes('rare') ? '#5dade2' : '#aaa', width: 48, height: 48 }}
                  title={item.label}
                  onClick={() => { onAction(item.id); }}>
                  <ItemSprite id={item.sprite} size={32} />
                </button>
              ))}
            </div>
          </div>
        ))}
        <button className="btn btn-gold" style={{ marginTop: 8 }} onClick={onClose}>Close</button>
       </div>
    </div>
  )
}

// ── DungeonMiniMap ────────────────────────────────────────────────────────────
// Shows a compact 2-room progress strip: Room 1 → Room 2
// Room states: 'current' (gold) | 'cleared' (green) | 'locked' (gray) | 'active-boss' (red pulse)
function DungeonMiniMap({ spec }: { spec: any }) {
  const currentRoom = spec.currentRoom || 1
  const bossHP = spec.bossHP ?? 1
  const room2BossHP = spec.room2BossHP ?? 1
  const monsterHP: number[] = spec.monsterHP || []
  const room2MonsterHP: number[] = spec.room2MonsterHP || []
  const treasureOpened = spec.treasureOpened ?? 0
  const doorUnlocked = spec.doorUnlocked ?? 0
  const allDead1 = monsterHP.length > 0 && monsterHP.every((h: number) => h <= 0)
  const allDead2 = room2MonsterHP.length > 0 && room2MonsterHP.every((h: number) => h <= 0)
  const heroHP = spec.heroHP ?? 1

  // Room 1 state
  let r1State: 'current' | 'cleared' | 'boss-active' = 'current'
  if (currentRoom === 1 && allDead1 && bossHP <= 0 && heroHP > 0) r1State = 'cleared'
  else if (currentRoom === 1 && allDead1 && bossHP > 0) r1State = 'boss-active'

  // Room 2 state
  let r2State: 'locked' | 'current' | 'cleared' | 'boss-active' = 'locked'
  if (currentRoom === 2) {
    if (allDead2 && room2BossHP <= 0 && heroHP > 0) r2State = 'cleared'
    else if (allDead2 && room2BossHP > 0) r2State = 'boss-active'
    else r2State = 'current'
  } else if (doorUnlocked > 0) {
    r2State = 'current'
  }

  const stateColor = (s: string) => {
    if (s === 'cleared') return '#00ff41'
    if (s === 'current') return '#f5c518'
    if (s === 'boss-active') return '#e94560'
    return '#333'
  }
  const stateLabel = (s: string, n: number) => {
    if (s === 'cleared') return `R${n} ✓`
    if (s === 'boss-active') return `R${n} ⚔`
    if (s === 'locked') return `R${n} 🔒`
    return `R${n}`
  }

  return (
    <div className="dungeon-minimap" aria-label="Dungeon progress map">
      <div className="minimap-room" style={{ borderColor: stateColor(r1State), color: stateColor(r1State) }}>
        {stateLabel(r1State, 1)}
        {r1State === 'cleared' && treasureOpened === 0 && (
          <span className="minimap-icon" title="Treasure available">💎</span>
        )}
      </div>
      <div className="minimap-connector" style={{ background: r2State !== 'locked' ? '#f5c518' : '#333' }}>
        {r2State !== 'locked' ? '→' : '⋯'}
      </div>
      <div className="minimap-room" style={{ borderColor: stateColor(r2State), color: stateColor(r2State) }}>
        {stateLabel(r2State, 2)}
      </div>
    </div>
  )
}

function HelpModal({ onClose, onCheat }: { onClose: () => void; onCheat: () => void }) {
  const [page, setPage] = useState(0)
  const bufRef = useRef('')
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      bufRef.current += e.key
      if (bufRef.current.includes('999')) { bufRef.current = ''; onClose(); setTimeout(onCheat, 100) }
      if (bufRef.current.length > 10) bufRef.current = bufRef.current.slice(-5)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onCheat])
  const pages = [
    { title: 'Combat Basics', content: (
      <>
        <p>Click a monster or boss to roll dice and attack. Damage is computed server-side based on difficulty.</p>
        <p>After your attack, all alive enemies counter-attack automatically. Kill all monsters to unlock the boss. Defeat the boss to win!</p>
        <table className="help-table">
          <thead><tr><th>Difficulty</th><th>Monster HP</th><th>Boss HP</th><th>Dice</th><th>Counter/Mon</th><th>Boss Counter</th></tr></thead>
          <tbody>
            <tr><td className="tag-easy">Easy</td><td>30</td><td>200</td><td>1d20+3</td><td>1</td><td>3</td></tr>
            <tr><td className="tag-normal">Normal</td><td>50</td><td>400</td><td>2d12+6</td><td>2</td><td>5</td></tr>
            <tr><td className="tag-hard">Hard</td><td>80</td><td>800</td><td>3d20+8</td><td>3</td><td>8</td></tr>
          </tbody>
        </table>
      </>
    )},
    { title: 'Hero Classes', content: (
      <>
        <table className="help-table">
          <thead><tr><th>Class</th><th>HP</th><th>Damage</th><th>Passive</th></tr></thead>
          <tbody>
            <tr><td><PixelIcon name="sword" size={10} /> Warrior</td><td>200</td><td>1.0x</td><td>25% damage reduction on all counter-attacks</td></tr>
            <tr><td><PixelIcon name="mana" size={10} /> Mage</td><td>120</td><td>1.3x all</td><td>8 mana (1/attack). Half damage at 0 mana</td></tr>
            <tr><td><PixelIcon name="dagger" size={10} /> Rogue</td><td>150</td><td>1.1x</td><td>25% chance to dodge counter-attacks entirely</td></tr>
          </tbody>
        </table>
      </>
    )},
    { title: 'Hero Abilities', content: (
      <>
        <table className="help-table">
          <thead><tr><th>Class</th><th>Ability</th><th>Cost</th><th>Effect</th></tr></thead>
          <tbody>
            <tr><td><PixelIcon name="shield" size={10} /> Warrior</td><td>Taunt</td><td>1 turn</td><td>60% damage reduction for 1 round (50% taunt + 20% passive). Enemies still counter-attack.</td></tr>
            <tr><td><PixelIcon name="heal" size={10} /> Mage</td><td>Heal</td><td>2 mana</td><td>Restore 40 HP (capped at 120). +1 mana regen when killing a monster.</td></tr>
            <tr><td><PixelIcon name="dagger" size={10} /> Rogue</td><td>Backstab</td><td>3-turn CD</td><td>3x damage multiplier. Cooldown decrements each turn.</td></tr>
          </tbody>
        </table>
      </>
    )},
    { title: 'Dungeon Modifiers', content: (
      <>
        <p>Each dungeon spawns with a random modifier (80% chance).</p>
        <table className="help-table">
          <thead><tr><th>Modifier</th><th>Type</th><th>Effect</th></tr></thead>
          <tbody>
            <tr><td>Fortitude</td><td style={{color:'#e74c3c'}}>Curse</td><td>Monsters +50% HP</td></tr>
            <tr><td>Fury</td><td style={{color:'#e74c3c'}}>Curse</td><td>Boss counter-attack 2x damage</td></tr>
            <tr><td>Darkness</td><td style={{color:'#e74c3c'}}>Curse</td><td>Hero damage -25%</td></tr>
            <tr><td>Strength</td><td style={{color:'#2ecc71'}}>Blessing</td><td>Hero damage +50%</td></tr>
            <tr><td>Resilience</td><td style={{color:'#2ecc71'}}>Blessing</td><td>Counter-attack damage halved</td></tr>
            <tr><td>Fortune</td><td style={{color:'#2ecc71'}}>Blessing</td><td>20% chance to crit (2x damage)</td></tr>
          </tbody>
        </table>
      </>
    )},
    { title: 'Loot & Items', content: (
      <>
        <p>Monsters drop items on death. Boss always drops rare/epic loot. Click items in backpack to use or equip.</p>
        <table className="help-table">
          <thead><tr><th>Item</th><th>Common</th><th>Rare</th><th>Epic</th></tr></thead>
          <tbody>
            <tr><td><PixelIcon name="sword" size={10} /> Weapon</td><td>+5 dmg (3 uses)</td><td>+10 dmg</td><td>+20 dmg</td></tr>
            <tr><td><PixelIcon name="shield" size={10} /> Armor</td><td>+10% def</td><td>+20% def</td><td>+30% def</td></tr>
            <tr><td><PixelIcon name="heart" size={10} /> HP Potion</td><td>+20 HP</td><td>+40 HP</td><td>Full heal</td></tr>
            <tr><td><PixelIcon name="mana" size={10} /> Mana Potion</td><td>+2 mana</td><td>+3 mana</td><td>+8 mana</td></tr>
          </tbody>
        </table>
        <p>Drop chance: Easy 60%, Normal 45%, Hard 35%</p>
      </>
    )},
    { title: 'Status Effects', content: (
      <>
        <p>Enemies can inflict status effects during counter-attacks. Effects apply at the start of your next turn.</p>
        <table className="help-table">
          <thead><tr><th>Effect</th><th>Source</th><th>Duration</th><th>Damage</th></tr></thead>
          <tbody>
            <tr><td><PixelIcon name="poison" size={10} /> Poison</td><td>Monsters (20%)</td><td>3 turns</td><td>-5 HP/turn</td></tr>
            <tr><td><PixelIcon name="fire" size={10} /> Burn</td><td>Boss (25%)</td><td>2 turns</td><td>-8 HP/turn</td></tr>
            <tr><td><PixelIcon name="lightning" size={10} /> Stun</td><td>Boss (15%)</td><td>1 turn</td><td>Skip attack</td></tr>
          </tbody>
        </table>
        <p>Effects don't stack — new application is blocked while active.</p>
      </>
    )},
    { title: 'Tips & Strategy', content: (
      <>
        <p><b>General:</b> Kill monsters first to reduce counter-attack damage before engaging the boss.</p>
        <p><b>Warrior:</b> Best for beginners. High HP lets you survive many hits. Use Taunt before big boss attacks.</p>
        <p><b>Mage:</b> Glass cannon. Rush the boss with 1.3x damage. Heal when low. Mana regens on monster kills.</p>
        <p><b>Rogue:</b> High risk/reward. Dodge procs can save you. Save Backstab (3x) for the boss.</p>
        <p><b>Items:</b> Equip weapons before attacking the boss. Use potions freely — they don't cost a turn.</p>
        <p><b>Modifiers:</b> Blessing of Fortune (20% crit) is the strongest. Curse of Fury makes boss fights brutal.</p>
      </>
    )},
  ]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" role="dialog" aria-modal="true" aria-label={`Help: ${pages[page].title}`} onClick={e => e.stopPropagation()}>
        <h2 style={{ color: 'var(--gold)', fontSize: 12, marginBottom: 4 }}>📖 {pages[page].title}</h2>
        <div className="help-page-indicator">{page + 1} / {pages.length}</div>
        <div className="help-section">{pages[page].content}</div>
        <div className="help-nav">
          <button className="btn btn-gold" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <button className="btn btn-gold" onClick={onClose}>Close</button>
          <button className="btn btn-gold" disabled={page === pages.length - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      </div>
    </div>
  )
}
function getModifierArenaStyle(modifier: string | undefined): React.CSSProperties {
  switch (modifier) {
    case 'curse-darkness':
      return { filter: 'brightness(0.75) contrast(1.1)', boxShadow: '0 0 30px rgba(180,0,0,0.4) inset' }
    case 'curse-fury':
      return { filter: 'hue-rotate(15deg) saturate(1.3)', boxShadow: '0 0 30px rgba(220,50,50,0.5) inset' }
    case 'curse-fortitude':
      return { filter: 'contrast(1.15)', boxShadow: '0 0 20px rgba(100,100,100,0.4) inset' }
    case 'blessing-strength':
      return { boxShadow: '0 0 30px rgba(245,197,24,0.4) inset' }
    case 'blessing-resilience':
      return { boxShadow: '0 0 30px rgba(46,204,113,0.4) inset' }
    case 'blessing-fortune':
      return {}
    default:
      return {}
  }
}

function DungeonView({ cr, prevCr, onBack, onNewGamePlus, onAttack, events, k8sLog, showLoot, onOpenLoot, onCloseLoot, attackPhase, roomLoading, animPhase, attackTarget, showHelp, onToggleHelp, showCheat, onToggleCheat, floatingDmg, bossPhaseFlash, combatModal, onDismissCombat, lootDrop, onDismissLoot, wsConnected, apiError, kroUnlocked, onViewKroConcept, reconciling, onOpenLeaderboard }: {
  cr: DungeonCR; prevCr?: DungeonCR | null; onBack: () => void; onNewGamePlus?: () => void; onAttack: (t: string, d: number) => void; events: WSEvent[]; k8sLog: { ts: string; cmd: string; res: string; yaml?: string }[]
  showLoot: boolean; onOpenLoot: () => void; onCloseLoot: () => void
  attackPhase: string | null; roomLoading: boolean
  animPhase: string; attackTarget: string | null
  showHelp: boolean; onToggleHelp: () => void
  showCheat: boolean; onToggleCheat: () => void
  floatingDmg: { target: string; amount: string; color: string } | null
  bossPhaseFlash: 'enraged' | 'berserk' | null
  combatModal: { phase: string; formula: string; heroAction: string; enemyAction: string; spec: any; oldHP: number } | null
  onDismissCombat: () => void
  lootDrop: string | null; onDismissLoot: () => void
  wsConnected: boolean
  apiError: string | null
  kroUnlocked: Set<KroConceptId>
  onViewKroConcept: (id: KroConceptId) => void
  reconciling: boolean
  onOpenLeaderboard: () => void
}) {
  if (!cr?.metadata?.name) return <div className="loading">Loading dungeon</div>
  const spec = cr.spec || { monsters: 0, difficulty: 'normal', monsterHP: [], bossHP: 0, heroHP: 100 }
  const status = cr.status
  const dungeonName = cr.metadata.name
  const maxMonsterHP = Number(status?.maxMonsterHP) || Math.max(...(spec.monsterHP || [1]))
  const maxBossHP = Number(status?.maxBossHP) || spec.bossHP
  const heroHP = spec.heroHP ?? 100
  const maxHeroHP = Number(status?.maxHeroHP) || heroHP
  const isDefeated = status?.defeated || heroHP <= 0
  const allMonstersDead = (spec.monsterHP || []).every((hp: number) => hp <= 0)
  const bossState = spec.bossHP <= 0 ? 'defeated' : allMonstersDead ? 'ready' : 'pending'
  // Boss phase — read from kro-derived status (boss-graph CEL), fallback to local derivation
  const bossPhase: 'phase1' | 'phase2' | 'phase3' | 'defeated' = (() => {
    if (spec.bossHP <= 0) return 'defeated'
    const fromStatus = status?.bossPhase as string | undefined
    if (fromStatus && fromStatus !== 'phase1') return fromStatus as 'phase2' | 'phase3'
    if (maxBossHP > 0) {
      const pct = (spec.bossHP / maxBossHP) * 100
      if (pct <= 25) return 'phase3'
      if (pct <= 50) return 'phase2'
    }
    return 'phase1'
  })()
  // During room 2 transition, bossHP=0 is stale from room 1 — not a real victory
  const inRoomTransition = (spec.currentRoom || 1) === 2 && spec.bossHP <= 0 && allMonstersDead && (spec.room2BossHP || 0) > 0 && (spec.room2MonsterHP?.length ?? 0) > 0
  const gameOver = isDefeated || (!inRoomTransition && spec.bossHP <= 0 && allMonstersDead)
  const isVictory = gameOver && !isDefeated && (spec.currentRoom || 1) === 2
  const [showCertificate, setShowCertificate] = useState(false)
  const [showDungeonHamburger, setShowDungeonHamburger] = useState(false)
  const [showPlayground, setShowPlayground] = useState(false)
  // Auto-show certificate once on room-2 victory
  const certShownRef = useRef(false)
  useEffect(() => {
    if (isVictory && !certShownRef.current) {
      certShownRef.current = true
      setTimeout(() => setShowCertificate(true), 800)
    }
  }, [isVictory])

  // Room 1 cleared celebration — show for 3s when boss defeated in room 1
  const [showRoom1Cleared, setShowRoom1Cleared] = useState(false)
  const room1ClearedRef = useRef(false)
  const room1IsCleared = (spec.currentRoom || 1) === 1 && spec.bossHP <= 0 && allMonstersDead && !isDefeated
  useEffect(() => {
    if (room1IsCleared && !room1ClearedRef.current) {
      room1ClearedRef.current = true
      setShowRoom1Cleared(true)
      setTimeout(() => setShowRoom1Cleared(false), 3000)
    }
  }, [room1IsCleared])
  const [showDoorModal, setShowDoorModal] = useState(false)
  const [doorPassword, setDoorPassword] = useState('')
  const autoTriggeredRef = useRef('')
  const [dismissedEngineWarning, setDismissedEngineWarning] = useState('')

  // Derive kro reconciliation error from status.conditions.
  // Suppressed for the first 30s after creation (transient reconcile race on fresh dungeons).
  // Known transient messages are mapped to friendly text instead of raw kro internals.
  const engineWarning = (() => {
    const ageMs = cr.metadata.creationTimestamp
      ? Date.now() - new Date(cr.metadata.creationTimestamp).getTime()
      : Infinity
    if (ageMs < 30000) return null

    const conditions = (status as any)?.conditions as Array<{ type: string; status: string; message?: string; reason?: string }> | undefined
    if (!conditions?.length) return null
    const errCond = conditions.find(c => c.type === 'Error' && c.message)
    const falseCond = conditions.find(c => c.status === 'False' && c.message)
    const raw = errCond?.message ?? falseCond?.message ?? null
    if (!raw) return null

    // Suppress known-transient kro reconcile messages — these fire on every
    // reconcile cycle and are not actionable. Only surface genuinely unexpected
    // condition messages that the user could act on.
    if (raw.includes('cluster mutated') || raw.includes('reconciliation failed') ||
        raw.includes('NotReady') || raw.includes('not ready'))
      return null
    return raw
  })()

  // Auto-clear dismissal when the warning resolves so future real errors can show
  useEffect(() => {
    if (!engineWarning) setDismissedEngineWarning('')
  }, [engineWarning])

  // Auto-open treasure and unlock door after boss kill (room 1 only)
  useEffect(() => {
    const currentRoom = spec.currentRoom || 1
    if (currentRoom !== 1 || !allMonstersDead || spec.bossHP > 0 || isDefeated || attackPhase) return
    const treasureOpened = (spec.treasureOpened ?? 0) === 1
    const doorUnlocked = (spec.doorUnlocked ?? 0) === 1
    if (!treasureOpened && autoTriggeredRef.current !== 'open-treasure') {
      autoTriggeredRef.current = 'open-treasure'
      onAttack('open-treasure', 0)
    } else if (treasureOpened && !doorUnlocked && autoTriggeredRef.current !== 'unlock-door') {
      autoTriggeredRef.current = 'unlock-door'
      onAttack('unlock-door', 0)
    }
  }, [spec.bossHP, allMonstersDead, spec.treasureOpened, spec.doorUnlocked, attackPhase])

  // Build turn order for display
  const turnOrder: { id: string; label: string; alive: boolean }[] = [{ id: 'hero', label: '🛡️ Hero', alive: !isDefeated }]
  ;(spec.monsterHP || []).forEach((hp, i) => {
    turnOrder.push({ id: `monster-${i}`, label: `👹 M${i}`, alive: hp > 0 })
  })
  if (bossState !== 'pending') {
    turnOrder.push({ id: 'boss', label: '🐉 Boss', alive: bossState === 'ready' })
  }

  return (
    <div>
       <div className="dungeon-header">
         <h2><PixelIcon name="sword" size={14} /> {dungeonName}{spec.runCount != null && spec.runCount > 0 ? <span className="ng-plus-badge" style={{ fontSize: '6px', marginLeft: 6 }}>⭐NG+{spec.runCount}</span> : null}</h2>
         <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
           <button className="help-btn" aria-label="Help" onClick={onToggleHelp}>?</button>
           <div style={{ position: 'relative' }}>
             <button className="hamburger-btn" aria-label="Menu" onClick={() => setShowDungeonHamburger(v => !v)}>☰</button>
             {showDungeonHamburger && (
               <div className="hamburger-menu" onMouseLeave={() => setShowDungeonHamburger(false)}>
                 <button className="hamburger-item" onClick={() => { setShowDungeonHamburger(false); onOpenLeaderboard() }}>Leaderboard</button>
                 <button className="hamburger-item" onClick={() => { setShowDungeonHamburger(false); setShowPlayground(true) }}>CEL Playground</button>
               </div>
             )}
           </div>
           <button className="back-btn" onClick={onBack}>← Back</button>
         </div>
       </div>

       {/* ── Mini-map ─────────────────────────────────────────────────── */}
       <DungeonMiniMap spec={spec} />

      {showHelp && <HelpModal onClose={onToggleHelp} onCheat={onToggleCheat} />}

      {showCheat && <CheatModal onClose={onToggleCheat} onAction={(target: string) => onAttack(target, 0)} />}

      {!wsConnected && (
        <div className="ws-reconnecting-banner">
          ○ Reconnecting to server...
        </div>
      )}

      {wsConnected && apiError && (
        <div className="ws-reconnecting-banner">
          ○ {apiError}
        </div>
      )}

      {engineWarning && engineWarning !== dismissedEngineWarning && (
        <div className="engine-warning-banner" role="alert">
          <span>Engine warning: {engineWarning}</span>
          <button
            onClick={() => setDismissedEngineWarning(engineWarning)}
            aria-label="Dismiss engine warning"
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px', marginLeft: 8 }}
          >✕</button>
        </div>
      )}

      {combatModal && (
        <div className="modal-overlay combat-overlay">
          <div className="modal combat-modal" role="dialog" aria-modal="true" aria-label="Combat" onClick={e => e.stopPropagation()}>
            {combatModal.phase === 'rolling' ? (
              <>
                <h2 style={{ color: 'var(--gold)', fontSize: 14, marginBottom: 16 }}>COMBAT</h2>
                <DiceRoller formula={combatModal.formula} />
                <p style={{ fontSize: 8, color: '#888', marginTop: 12 }}>Waiting for attack to resolve...</p>
                <div style={{ marginTop: 8, fontSize: 6, color: '#2a4a6a', textAlign: 'center', lineHeight: 1.8 }}>
                  <span className="kro-insight-badge" style={{ fontSize: 5 }}>kro</span>
                  {' '}dungeon-graph reconciling → combatResult CEL computing {combatModal.formula}
                  {' '}<button onClick={() => onViewKroConcept('reconcile-loop')} style={{ background: 'none', border: 'none', color: '#00d4ff', cursor: 'pointer', fontSize: 6, fontFamily: 'inherit', padding: 0, textDecoration: 'underline' }}>what is this?</button>
                </div>
              </>
            ) : (
              <>
                <button className="modal-close" aria-label="Close combat results" onClick={onDismissCombat}>✕</button>
                <h2 style={{ color: 'var(--gold)', fontSize: 14, marginBottom: 12 }}>COMBAT RESULTS</h2>
                <CombatBreakdown heroAction={combatModal.heroAction} enemyAction={combatModal.enemyAction} spec={combatModal.spec} oldHP={combatModal.oldHP} />
                {combatModal.heroAction && (
                  <CelTrace
                    data={{
                      formula: combatModal.formula,
                      difficulty: combatModal.spec?.difficulty || spec.difficulty || 'normal',
                      heroClass: combatModal.spec?.heroClass || spec.heroClass || 'warrior',
                      heroAction: combatModal.heroAction,
                      combatLog: combatModal.spec?.lastCombatLog || '',
                      modifier: combatModal.spec?.modifier ?? spec.modifier,
                      helmetBonus: combatModal.spec?.helmetBonus ?? spec.helmetBonus,
                      pantsBonus: combatModal.spec?.pantsBonus ?? spec.pantsBonus,
                    }}
                    onLearnMore={() => onViewKroConcept('cel-basics')}
                  />
                )}
                <button className="btn btn-gold" style={{ marginTop: 16 }} onClick={onDismissCombat}>Continue</button>
              </>
            )}
          </div>
        </div>
      )}

      {!gameOver && !combatModal && (
        <div className="turn-bar">
          <span className="turn-indicator"><PixelIcon name="sword" size={12} /> Ready to attack!</span>
        </div>
      )}

      {isDefeated && (
        <div className="defeat-banner">
          <h2><PixelIcon name="skull" size={18} /> DEFEAT <PixelIcon name="skull" size={18} /></h2>
          <p className="defeat-text">Your hero has fallen...</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', margin: '8px 0', fontSize: 7, color: 'var(--text-dim)' }}>
            <span>Turns: <span style={{ color: 'var(--gold)' }}>{spec.attackSeq ?? 0}</span></span>
            <span>Hero: <span style={{ color: 'var(--gold)' }}>{spec.heroClass ?? 'warrior'}</span></span>
            <span>Difficulty: <span style={{ color: 'var(--gold)' }}>{spec.difficulty}</span></span>
            <span>Room: <span style={{ color: 'var(--gold)' }}>{spec.currentRoom ?? 1}</span></span>
            {spec.weaponBonus ? <span>⚔ Weapon +{spec.weaponBonus}</span> : null}
            {spec.armorBonus ? <span>🛡 Armor {spec.armorBonus}%</span> : null}
            {spec.ringBonus ? <span>💍 Ring +{spec.ringBonus}/turn</span> : null}
            {spec.amuletBonus ? <span>📿 Amulet +{spec.amuletBonus}%dmg</span> : null}
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn" style={{ fontSize: 7 }} onClick={onBack}>← New Dungeon</button>
          </div>
        </div>
      )}

      {gameOver && !isDefeated && (spec.currentRoom || 1) === 2 && (
        <div className="victory-banner">
          <h2><PixelIcon name="crown" size={18} /> VICTORY! <PixelIcon name="crown" size={18} /></h2>
          <p className="loot">The dungeon has been conquered!</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', margin: '8px 0', fontSize: 7, color: 'var(--text-dim)' }}>
            <span>Turns: <span style={{ color: 'var(--gold)' }}>{spec.attackSeq ?? 0}</span></span>
            <span>Hero: <span style={{ color: 'var(--gold)' }}>{spec.heroClass ?? 'warrior'}</span></span>
            <span>Difficulty: <span style={{ color: 'var(--gold)' }}>{spec.difficulty}</span></span>
            {spec.weaponBonus ? <span>⚔ Weapon +{spec.weaponBonus}</span> : null}
            {spec.armorBonus ? <span>🛡 Armor {spec.armorBonus}%</span> : null}
            {spec.helmetBonus ? <span>⛑ Helmet +{spec.helmetBonus}%crit</span> : null}
            {spec.pantsBonus ? <span>👖 Pants +{spec.pantsBonus}%dodge</span> : null}
            {spec.ringBonus ? <span>💍 Ring +{spec.ringBonus}/turn</span> : null}
            {spec.amuletBonus ? <span>📿 Amulet +{spec.amuletBonus}%dmg</span> : null}
          </div>
          <AchievementBadges achievements={computeAchievements(spec, spec.heroClass === 'mage' ? 120 : spec.heroClass === 'rogue' ? 150 : 200)} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8 }}>
            <button className="btn btn-gold" style={{ fontSize: 7 }} onClick={() => setShowCertificate(true)}>
              View kro Certificate →
            </button>
            {onNewGamePlus && (
              <button className="btn btn-gold" style={{ fontSize: 7, borderColor: '#00ff41', color: '#00ff41', background: 'rgba(0,255,65,0.08)' }} onClick={onNewGamePlus}>
                ⭐ New Game+
              </button>
            )}
            <button className="btn" style={{ fontSize: 7 }} onClick={onBack}>
              ← New Dungeon
            </button>
          </div>
        </div>
      )}

      {showCertificate && (
        <KroExpertCertificate
          dungeonName={dungeonName}
          heroClass={spec.heroClass || 'warrior'}
          difficulty={spec.difficulty || 'normal'}
          turns={spec.attackSeq || 0}
          unlocked={kroUnlocked}
          k8sLog={k8sLog}
          onClose={() => setShowCertificate(false)}
        />
      )}

      {lootDrop && !combatModal && (
        <div className="modal-overlay" onClick={onDismissLoot}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Loot drop" onClick={e => e.stopPropagation()}>
            <div style={{ marginBottom: 12 }}><PixelIcon name="chest" size={48} /></div>
            <h2 style={{ color: 'var(--gold)', fontSize: 12, marginBottom: 8 }}>LOOT DROP!</h2>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
              <ItemSprite id={lootDrop} size={48} />
            </div>
            <div style={{ fontSize: 9, color: lootDrop.includes('epic') ? '#9b59b6' : lootDrop.includes('rare') ? '#5dade2' : '#aaa', marginBottom: 4 }}>
              {lootDrop.replace(/-/g, ' ').toUpperCase()}
            </div>
            <div style={{ fontSize: 7, color: 'var(--text-dim)', marginBottom: 12 }}>
              {lootDrop.includes('weapon') ? 'Equip for bonus damage on next 3 attacks' :
               lootDrop.includes('armor') ? 'Equip for damage reduction this dungeon' :
               lootDrop.includes('hppotion') ? 'Use to restore HP' :
               lootDrop.includes('manapotion') ? 'Use to restore mana' :
               lootDrop.includes('helmet') ? 'Equip for a chance to land critical hits' :
               lootDrop.includes('pants') ? 'Equip for a chance to dodge counter-attacks' :
               lootDrop.includes('boots') ? 'Equip to resist status effects' :
               lootDrop.includes('ring') ? 'Equip for passive HP regen each round' :
               lootDrop.includes('amulet') ? 'Equip to boost all damage dealt' : 'A mysterious item'}
            </div>
            <button className="btn btn-gold" onClick={onDismissLoot}>Got it!</button>
          </div>
        </div>
      )}

      <div className="status-bar">
        <Tooltip text={KRO_STATUS_TIPS.livingMonsters}>
          <div><span className="label">Monsters alive:</span><span className="value">{status?.livingMonsters ?? '?'}</span></div>
        </Tooltip>
        <Tooltip text={KRO_STATUS_TIPS.bossState}>
          <div><span className="label">Boss:</span><span className="value">{bossState}</span></div>
        </Tooltip>
        <Tooltip text={KRO_STATUS_TIPS.difficulty}>
          <div><span className="label">Difficulty:</span><span className="value">{spec.difficulty}</span></div>
        </Tooltip>
        <Tooltip text={KRO_STATUS_TIPS.room}>
          <div><span className="label">Room:</span><span className="value">{spec.currentRoom || 1}</span></div>
        </Tooltip>
        <Tooltip text={KRO_STATUS_TIPS.turn}>
          <div><span className="label">Turn:</span><span className="value">{(spec.attackSeq ?? 0) + 1}</span></div>
        </Tooltip>
      </div>

      <div className="game-layout">
        {/* LEFT PANEL — Dungeon Arena */}
        <div className="left-panel">
          <div className={`dungeon-arena${spec.modifier === 'blessing-fortune' ? ' arena-blessing-fortune' : ''}`} style={getModifierArenaStyle(spec.modifier)}>
            {/* Stone floor texture layers */}
            <div className="arena-floor" />
            <div className="arena-glow" />

            {/* Dungeon props — scattered decorations */}
            {[
              // 4 plants
              { src: 'ghost-plants', x: 15, y: 55, size: 28, rot: 0 },
              { src: 'ghost-plants', x: 85, y: 60, size: 24, rot: 15 },
              { src: 'ghost-plants', x: 25, y: 85, size: 22, rot: -10 },
              { src: 'ghost-plants', x: 70, y: 88, size: 26, rot: 5 },
              // 3 stones
              { src: 'rocks', x: 8, y: 35, size: 36, rot: 0 },
              { src: 'rocks', x: 55, y: 88, size: 30, rot: 45 },
              { src: 'rocks', x: 90, y: 30, size: 28, rot: -20 },
              // 2 broken arrows
              { src: 'broken-arrows', x: 88, y: 45, size: 30, rot: 20 },
              { src: 'broken-arrows', x: 35, y: 82, size: 26, rot: -30 },
              // 1 broken flask
              { src: 'broken-flask', x: 78, y: 72, size: 24, rot: -10 },
              // 2 bones
              { src: 'bones', x: 12, y: 75, size: 32, rot: -15 },
              { src: 'bones', x: 75, y: 78, size: 28, rot: 25 },
              // 1 skull
              { src: 'skull', x: 45, y: 90, size: 28, rot: 10 },
              // corner webs (one on top of rock at x:8 y:35)
              { src: 'corner-web', x: 10, y: 30, size: 44, rot: -10 },
              { src: 'corner-web', x: 95, y: 8, size: 44, rot: 90 },
            ].map((p, i) => (
              <img key={i} src={`/sprites/dungeon/${p.src}.png`} alt="" className="dungeon-prop"
                style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, transform: `translate(-50%,-50%) rotate(${p.rot}deg)` }} />
            ))}

            {/* Door at top of arena — room 1 only */}
            {(spec.currentRoom || 1) === 1 && (
            <div className="arena-entity door-entity" style={{ top: '8%', left: '50%' }}>
              {(() => {
                const doorUnlocked = (spec.doorUnlocked ?? 0) === 1
                const unlocking = (spec.treasureOpened ?? 0) === 1 && !doorUnlocked
                return <>
                  <img src={`/sprites/dungeon/door-${doorUnlocked ? 'opened' : 'closed'}.png`}
                    alt="door" style={{ width: 64, height: 64, imageRendering: 'pixelated' as any, cursor: doorUnlocked ? 'pointer' : 'default', filter: doorUnlocked ? 'drop-shadow(0 0 6px #f5c518)' : 'none' }}
                    onClick={() => {
                      if (attackPhase) return
                      if (doorUnlocked) onAttack('enter-room-2', 0)
                    }} />
                  {unlocking && <div style={{ fontSize: 7, color: '#aaa', textAlign: 'center', marginTop: 2 }}>Unlocking...</div>}
                  {doorUnlocked && <div style={{ fontSize: 7, color: 'var(--gold)', textAlign: 'center', marginTop: 2 }}>🚪 Enter</div>}
                </>
              })()}
            </div>
            )}

            {/* Treasure chest — appears after boss defeated in room 1, auto-opens */}
            {(spec.currentRoom || 1) === 1 && (spec.bossHP <= 0 && allMonstersDead) && (
              <div className="arena-entity chest-entity" style={{ top: '55%', left: '30%' }}>
                <img src={`/sprites/dungeon/chest-${(spec.treasureOpened ?? 0) === 1 ? 'opened' : 'closed'}.png`}
                  alt="chest" style={{ width: 56, height: 56, imageRendering: 'pixelated' as any, filter: (spec.treasureOpened ?? 0) === 0 ? 'drop-shadow(0 0 4px gold)' : 'none' }} />
                {(spec.treasureOpened ?? 0) === 0 && <div style={{ fontSize: 7, color: '#aaa', textAlign: 'center', marginTop: 2 }}>Opening...</div>}
                {(spec.treasureOpened ?? 0) === 1 && status?.loot && (
                  <div style={{ fontSize: 7, color: 'var(--gold)', textAlign: 'center', marginTop: 4, textShadow: '1px 1px 2px #000' }}>🔑 {status.loot}</div>
                )}
              </div>
            )}

            {/* Boss — visible when kro sets bossState to ready or defeated */}
            {bossState !== 'pending' && (() => {
              const inCombatB = combatModal && (combatModal.phase === 'rolling' || combatModal.phase === 'resolved')
              let bAction: SpriteAction = (bossState === 'defeated' || spec.bossHP <= 0) ? 'victory' : 'idle'
              if (inCombatB && attackTarget?.includes('boss')) bAction = 'attack'
              else if (inCombatB && bossState === 'ready') bAction = 'attack'
              if (!inCombatB && (status?.victory || spec.bossHP <= 0)) bAction = 'victory'
              const bossName = `${dungeonName}-boss`
              const phaseClass = bossState === 'ready' ? (bossPhase === 'phase3' ? ' boss-phase3' : bossPhase === 'phase2' ? ' boss-phase2' : '') : ''
              const phaseFlashClass = bossPhaseFlash ? ` boss-phase-flash-${bossPhaseFlash}` : ''
              return (
                <div className={`arena-entity boss-entity${phaseClass}${phaseFlashClass}`}
                  style={{ top: '40%', left: '50%' }}
                  role={bossState === 'ready' && !gameOver && !attackPhase ? 'button' : undefined}
                  tabIndex={bossState === 'ready' && !gameOver && !attackPhase ? 0 : undefined}
                  aria-label={`Boss · HP: ${spec.bossHP}/${maxBossHP}${bossState === 'defeated' ? ' (defeated)' : ''}`}
                  onKeyDown={bossState === 'ready' && !gameOver && !attackPhase ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAttack(bossName, 0) } } : undefined}>
                  {floatingDmg?.target?.includes('boss') && <div className="floating-dmg" style={{ color: '#e94560' }}>{floatingDmg.amount}</div>}
                  {bossPhaseFlash && (
                    <div className={`boss-phase-flash-overlay ${bossPhaseFlash}`}>
                      {bossPhaseFlash === 'enraged' ? '🔥 ENRAGED!' : '💀 BERSERK!'}
                    </div>
                  )}
                  {bossState === 'ready' && bossPhase !== 'phase1' && (
                    <div className={`boss-phase-badge ${bossPhase}`}>
                      {bossPhase === 'phase2' ? '🔥 ENRAGED' : '💀 BERSERK'}
                    </div>
                  )}
                  <Sprite spriteType={(spec.currentRoom || 1) === 2 ? 'bat-boss' : 'dragon'} action={bAction} size={144} />
                  <div className="arena-shadow" style={{ width: 120 }} />
                  <div className="arena-hover-ui">
                    <div className="arena-hp-bar"><div className={`arena-hp-fill ${spec.bossHP > 0 ? 'high' : 'low'}`} style={{ width: `${Math.min((spec.bossHP / maxBossHP) * 100, 100)}%` }} /></div>
                    <div className="arena-name">Boss · {spec.bossHP}/{maxBossHP}</div>
                    {bossState === 'ready' && !gameOver && !attackPhase && (
                      <div className="arena-actions">
                        <button className="btn btn-primary arena-atk-btn" onClick={() => onAttack(bossName, 0)}>🎲 {status?.diceFormula || '2d12+6'}</button>
                        {spec.heroClass === 'rogue' && (spec.backstabCooldown ?? 0) === 0 && (
                          <button className="btn btn-ability arena-atk-btn" onClick={() => onAttack(bossName + '-backstab', 0)}>Backstab</button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Monsters in semicircle */}
            {(spec.monsterHP || []).map((hp, idx) => {
              const count = spec.monsterHP.length
              const state = hp > 0 ? 'alive' : 'dead'
              const mName = `${dungeonName}-monster-${idx}`
              const mSprite = getMonsterSprite(idx, spec.currentRoom || 1, spec.monsterTypes)
              const mDisplayName = getMonsterName(idx, spec.currentRoom || 1, spec.monsterTypes)
              let mAction: SpriteAction = state === 'dead' ? 'dead' : 'idle'
              const inCombat = combatModal && (combatModal.phase === 'rolling' || combatModal.phase === 'resolved')
              if (inCombat && state === 'alive') mAction = 'attack'
              if (inCombat && attackTarget === mName) mAction = 'attack'

              // Position in semicircle (top arc around hero)
              const angle = count === 1 ? Math.PI / 2 : (Math.PI * 0.2) + (Math.PI * 0.6 / (count - 1)) * idx
              const radiusX = 38 // % from center
              const radiusY = 30
              const cx = 50 + Math.cos(angle) * radiusX
              const cy = 50 - Math.sin(angle) * radiusY
              const facingRight = cx < 50

              return (
                <div key={mName} className={`arena-entity monster-entity ${state}`}
                  style={{ left: `${cx}%`, top: `${cy}%` }}
                  role={state === 'alive' && !gameOver && !attackPhase ? 'button' : undefined}
                  tabIndex={state === 'alive' && !gameOver && !attackPhase ? 0 : undefined}
                  aria-label={`${mDisplayName} · HP: ${hp}/${maxMonsterHP}${state === 'dead' ? ' (dead)' : ''}`}
                  onKeyDown={state === 'alive' && !gameOver && !attackPhase ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAttack(mName, 0) } } : undefined}>
                  {floatingDmg?.target === mName && <div className="floating-dmg" style={{ color: '#e94560' }}>{floatingDmg.amount}</div>}
                  <Sprite spriteType={mSprite} action={mAction} size={72} flip={!facingRight} />
                  <div className="arena-shadow" />
                  <div className="arena-hover-ui">
                    <div className="arena-hp-bar"><div className={`arena-hp-fill ${hp > maxMonsterHP * 0.6 ? 'high' : hp > maxMonsterHP * 0.3 ? 'mid' : 'low'}`} style={{ width: `${Math.min((hp / maxMonsterHP) * 100, 100)}%` }} /></div>
                    <div className="arena-name">{mDisplayName} · {hp}/{maxMonsterHP}</div>
                    {state === 'alive' && !gameOver && !attackPhase && (
                      <div className="arena-actions">
                        <button className="btn btn-primary arena-atk-btn" onClick={() => onAttack(mName, 0)}>🎲 {status?.diceFormula || '2d12+6'}</button>
                        {spec.heroClass === 'rogue' && (spec.backstabCooldown ?? 0) === 0 && (
                          <button className="btn btn-ability arena-atk-btn" onClick={() => onAttack(mName + '-backstab', 0)}>Backstab</button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Hero in center */}
            <div className="arena-entity hero-entity" style={{ left: '50%', top: '70%' }}>
              {floatingDmg?.target === 'hero' && <div className="floating-dmg" style={{ color: floatingDmg.color }}>{floatingDmg.amount}</div>}
              <Sprite spriteType={spec.heroClass || 'warrior'} size={80}
                action={isDefeated ? 'dead' : status?.victory ? 'victory' : (animPhase === 'hero-attack' || (combatModal && combatModal.phase === 'rolling')) ? 'attack' : animPhase === 'enemy-attack' ? 'hurt' : animPhase === 'item-use' ? 'itemUse' : 'idle'} />
              <div className="arena-shadow" style={{ width: 60 }} />
            </div>

            {/* Room transition loading */}
            {roomLoading && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, borderRadius: 12 }}>
                <div style={{ textAlign: 'center', color: 'var(--gold)', fontSize: 12 }}>🚪 Entering Room 2...</div>
              </div>
            )}

            {/* Flying bats — Room 2 only (bat-boss lives here) */}
            {(spec.currentRoom || 1) === 2 && <DungeonBats />}

            {/* Room 1 cleared — 3s celebration overlay */}
            {showRoom1Cleared && (
              <div className="arena-room1-cleared">
                <div className="arena-room1-cleared-text">★ ROOM CLEARED! ★</div>
                <div style={{ fontSize: 7, color: 'var(--text-dim)', marginTop: 6 }}>Treasure awaits...</div>
              </div>
            )}

            {status?.victory && <div className="arena-victory-glow" />}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="right-panel">
          <div className="hero-section">
            <Sprite spriteType={spec.heroClass || 'warrior'} size={80}
              action={isDefeated ? 'dead' : status?.victory ? 'victory' : animPhase === 'hero-attack' ? 'attack' : animPhase === 'enemy-attack' ? 'hurt' : animPhase === 'item-use' ? 'itemUse' : 'idle'} />
            <div className="hero-label">{(spec.heroClass || 'warrior').toUpperCase()}</div>
            <div className="hp-bar-bg">
              <div className={`hp-bar-fill ${heroHP > 60 ? 'high' : heroHP > 30 ? 'mid' : 'low'}`}
                style={{ width: `${Math.min((heroHP / maxHeroHP) * 100, 100)}%` }} />
            </div>
            <div className="hero-hp-text">HP: {heroHP} / {maxHeroHP}</div>
            {spec.heroClass === 'mage' && <div className="mana-text"><PixelIcon name="mana" size={10} /> Mana: {spec.heroMana ?? 0}</div>}
            {floatingDmg?.target === 'hero' && <div className="floating-dmg" style={{ color: floatingDmg.color }}>{floatingDmg.amount}</div>}
          </div>

          {!gameOver && !attackPhase && (
            <div className="ability-bar">
              {spec.heroClass === 'mage' && (
                <button className="btn btn-ability" disabled={(spec.heroMana ?? 0) < 2 || heroHP >= maxHeroHP}
                  onClick={() => onAttack('hero', 0)}>
                  <PixelIcon name="heal" size={12} /> Heal
                </button>
              )}
              {spec.heroClass === 'warrior' && (
                <button className={`btn btn-ability${(spec.tauntActive ?? 0) > 0 ? ' active' : ''}`}
                  disabled={(spec.tauntActive ?? 0) > 0}
                  onClick={() => onAttack('activate-taunt', 0)}>
                  <PixelIcon name="shield" size={12} /> Taunt
                </button>
              )}
              {spec.heroClass === 'rogue' && (
                <span className="cooldown-text">
                  <PixelIcon name="dagger" size={12} /> Backstab: {(spec.backstabCooldown ?? 0) > 0 ? `${spec.backstabCooldown} CD` : 'Ready'}
                </span>
              )}
            </div>
          )}

          {(() => {
            const items = (spec.inventory || '').split(',').filter(Boolean)
            const wb = spec.weaponBonus || 0
            const wu = spec.weaponUses || 0
            const ab = spec.armorBonus || 0
            const sb = spec.shieldBonus || 0
            const hb = spec.helmetBonus || 0
            const pb = spec.pantsBonus || 0
            const bb = spec.bootsBonus || 0
            const rb = spec.ringBonus || 0
            const amb = spec.amuletBonus || 0
            const modifier = spec.modifier || 'none'
            const poison = spec.poisonTurns || 0
            const burn = spec.burnTurns || 0
            const stun = spec.stunTurns || 0
            const taunt = spec.tauntActive || 0
            const RARITY_COLOR: Record<string, string> = { common: '#aaa', rare: '#5dade2', epic: '#9b59b6' }
            return (
              <div className="equip-panel">
                <div className="equip-grid">
                  <div className="equip-row">
                    <Tooltip text={hb > 0 ? `Helmet equipped: ${hb}% chance to land critical hits` : 'Helmet — none equipped'}>
                      <div className={`equip-slot${hb > 0 ? ' filled' : ' empty'}`}>
                        {hb > 0 ? <><ItemSprite id={hb >= 15 ? 'helmet-epic' : hb >= 10 ? 'helmet-rare' : 'helmet-common'} size={22} /><span className="slot-stat">{hb}%</span></> : <PixelIcon name="helmet" size={14} color="#333" />}
                      </div>
                    </Tooltip>
                  </div>
                  <div className="equip-row">
                    <Tooltip text={sb > 0 ? `Shield equipped: ${sb}% chance to block counter-attacks` : 'Shield — none equipped'}>
                      <div className={`equip-slot${sb > 0 ? ' filled' : ' empty'}`}>
                        {sb > 0 ? <><ItemSprite id={sb >= 25 ? 'shield-epic' : sb >= 15 ? 'shield-rare' : 'shield-common'} size={22} /><span className="slot-stat">{sb}%</span></> : <PixelIcon name="shield" size={14} color="#333" />}
                      </div>
                    </Tooltip>
                    <Tooltip text={ab > 0 ? `Armor equipped: +${ab}% damage reduction` : 'Armor — none equipped'}>
                      <div className={`equip-slot${ab > 0 ? ' filled' : ' empty'}`}>
                        {ab > 0 ? <><ItemSprite id={ab >= 30 ? 'armor-epic' : ab >= 20 ? 'armor-rare' : 'armor-common'} size={22} /><span className="slot-stat">+{ab}%</span></> : <PixelIcon name="shield" size={14} color="#333" />}
                      </div>
                    </Tooltip>
                    <Tooltip text={wb > 0 ? `Weapon equipped: +${wb} damage (${wu} uses left)` : 'Weapon — none equipped'}>
                      <div className={`equip-slot${wb > 0 ? ' filled' : ' empty'}`}>
                        {wb > 0 ? <><ItemSprite id={wb >= 20 ? 'weapon-epic' : wb >= 10 ? 'weapon-rare' : 'weapon-common'} size={22} /><span className="slot-stat">+{wb}<br/>{wu}u</span></> : <PixelIcon name="sword" size={14} color="#333" />}
                      </div>
                    </Tooltip>
                  </div>
                  <div className="equip-row">
                    <Tooltip text={pb > 0 ? `Pants equipped: ${pb}% chance to dodge counter-attacks` : 'Pants — none equipped'}>
                      <div className={`equip-slot${pb > 0 ? ' filled' : ' empty'}`}>
                        {pb > 0 ? <><ItemSprite id={pb >= 15 ? 'pants-epic' : pb >= 10 ? 'pants-rare' : 'pants-common'} size={22} /><span className="slot-stat">{pb}%</span></> : <PixelIcon name="pants" size={14} color="#333" />}
                      </div>
                    </Tooltip>
                  </div>
                   <div className="equip-row">
                     <Tooltip text={bb > 0 ? `Boots equipped: ${bb}% chance to resist status effects` : 'Boots — none equipped'}>
                       <div className={`equip-slot${bb > 0 ? ' filled' : ' empty'}`}>
                         {bb > 0 ? <><ItemSprite id={bb >= 60 ? 'boots-epic' : bb >= 40 ? 'boots-rare' : 'boots-common'} size={22} /><span className="slot-stat">{bb}%</span></> : <PixelIcon name="boots" size={14} color="#333" />}
                       </div>
                     </Tooltip>
                   </div>
                    <div className="equip-row">
                      <Tooltip text={rb > 0 ? `Ring equipped: +${rb} HP regen at start of each round` : 'Ring — none equipped'}>
                        <div className={`equip-slot${rb > 0 ? ' filled' : ' empty'}`}>
                          {rb > 0 ? <><span style={{ fontSize: 16, lineHeight: 1 }}>💍</span><span className="slot-stat">+{rb}/t</span></> : <PixelIcon name="ring" size={14} color="#333" />}
                        </div>
                      </Tooltip>
                      <Tooltip text={amb > 0 ? `Amulet equipped: +${amb}% to all damage dealt` : 'Amulet — none equipped'}>
                        <div className={`equip-slot${amb > 0 ? ' filled' : ' empty'}`}>
                          {amb > 0 ? <><span style={{ fontSize: 16, lineHeight: 1 }}>📿</span><span className="slot-stat">+{amb}%</span></> : <PixelIcon name="amulet" size={14} color="#333" />}
                        </div>
                      </Tooltip>
                    </div>
                </div>

                <div className="status-row">
                  {modifier !== 'none' && <Tooltip text={`${modifier.startsWith('curse') ? 'Curse' : 'Blessing'}: ${status?.modifier || modifier}`}><div className={`status-badge ${modifier.startsWith('curse') ? 'curse' : 'blessing'}`}><ItemSprite id={modifier} size={18} /></div></Tooltip>}
                  {taunt > 0 && <Tooltip text={taunt === 1 ? 'Taunt ready: next attack has 60% counter-attack reduction' : 'TAUNTING: 60% counter-attack reduction active this turn'}><div className="status-badge effect taunt"><PixelIcon name="shield" size={12} /><span>{taunt === 2 ? 'ACT' : 'RDY'}</span></div></Tooltip>}
                  {poison > 0 && <Tooltip text={`Poison: -5 HP per turn, ${poison} turns remaining`}><div className="status-badge effect" data-effect="poison"><PixelIcon name="poison" size={12} /><span>{poison}</span></div></Tooltip>}
                  {burn > 0 && <Tooltip text={`Burn: -8 HP per turn, ${burn} turns remaining`}><div className="status-badge effect" data-effect="burn"><PixelIcon name="fire" size={12} /><span>{burn}</span></div></Tooltip>}
                  {stun > 0 && <Tooltip text={`Stun: skip next attack, ${stun} turns remaining`}><div className="status-badge effect" data-effect="stun"><PixelIcon name="lightning" size={12} /><span>{stun}</span></div></Tooltip>}
                </div>

                {items.length > 0 && (
                  <div className="backpack">
                    <div className="backpack-label">
                      Backpack
                      <span style={{ fontSize: 6, color: items.length >= 8 ? '#e74c3c' : items.length >= 6 ? '#f1c40f' : 'var(--text-dim)', marginLeft: 6 }}>
                        {items.length}/8{items.length >= 8 ? ' FULL' : ''}
                      </span>
                    </div>
                    <div className="backpack-grid">
                      {items.map((item, i) => {
                        const rarity = item.split('-').pop()!
                        const isPotion = item.includes('potion')
                        const desc =                           item.includes('weapon') ? `Weapon (${rarity}) — click to equip, +damage for 3 attacks` :
                          item.includes('armor') ? `Armor (${rarity}) — click to equip, +defense for dungeon` :
                          item.includes('hppotion') ? `HP Potion (${rarity}) — click to restore HP` :
                          item.includes('manapotion') ? `Mana Potion (${rarity}) — click to restore mana` :
                          item.includes('helmet') ? `Helmet (${rarity}) — click to equip, +crit chance` :
                          item.includes('pants') ? `Pants (${rarity}) — click to equip, +dodge chance` :
                          item.includes('boots') ? `Boots (${rarity}) — click to equip, +status resist` :
                          item.includes('ring') ? `Ring (${rarity}) — click to equip, +HP regen per round` :
                          item.includes('amulet') ? `Amulet (${rarity}) — click to equip, +% damage boost` : item
                        return (
                          <Tooltip key={i} text={desc}>
                            <button className="backpack-slot" disabled={gameOver || !!attackPhase}
                              style={{ borderColor: RARITY_COLOR[rarity] || '#555' }}
                              onClick={() => onAttack(isPotion ? `use-${item}` : `equip-${item}`, 0)}>
                              <ItemSprite id={item} size={22} />
                            </button>
                          </Tooltip>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </div>

      <KroGraphPanel cr={cr} prevCr={prevCr} reconciling={reconciling} onViewConcept={onViewKroConcept} />

      <EventLogTabs events={events} k8sLog={k8sLog} kroUnlocked={kroUnlocked} onViewKroConcept={onViewKroConcept}
        dungeonNs={cr.metadata.namespace} dungeonName={cr.metadata.name}
        showPlayground={showPlayground} onOpenPlayground={() => setShowPlayground(true)} onClosePlayground={() => setShowPlayground(false)} />
    </div>
  )
}

// Parse dice formula from CR status (e.g. "1d20+2" -> {count:2, sides:8, mod:5})
function CombatBreakdown({ heroAction, enemyAction, spec, oldHP }: { heroAction: string; enemyAction: string; spec: any; oldHP: number }) {
  const lines: { icon: string; text: string; color?: string }[] = []

  // DoT effects
  if (heroAction.includes('Poison')) lines.push({ icon: 'poison', text: 'Poison: -5 HP', color: '#2ecc71' })
  if (heroAction.includes('Burn')) lines.push({ icon: 'fire', text: 'Burn: -8 HP', color: '#e74c3c' })
  if (heroAction.includes('STUNNED')) lines.push({ icon: 'lightning', text: 'STUNNED! No damage dealt', color: '#f1c40f' })

  // Hero attack
  const dmgMatch = heroAction.match(/deals (\d+) damage.*\(HP: (\d+) -> (\d+)\)/)
  if (dmgMatch) lines.push({ icon: 'sword', text: `Dealt ${dmgMatch[1]} damage (${dmgMatch[2]} → ${dmgMatch[3]} HP)` })
  if (heroAction.includes('heals')) {
    const healMatch = heroAction.match(/heals for (\d+)/)
    if (healMatch) lines.push({ icon: 'heal', text: `Healed ${healMatch[1]} HP` })
  }
  if (heroAction.includes('Taunt')) lines.push({ icon: 'shield', text: 'Taunt activated! 60% damage reduction' })

  // Modifiers
  if (heroAction.includes('Blessing')) { const m = heroAction.match(/\[Blessing:[^\]]+\]/); if (m) lines.push({ icon: 'poison', text: m[0], color: '#2ecc71' }) }
  if (heroAction.includes('Curse')) { const m = heroAction.match(/\[Curse:[^\]]+\]/); if (m) lines.push({ icon: 'fire', text: m[0], color: '#e74c3c' }) }
  if (heroAction.includes('CRIT')) lines.push({ icon: 'star', text: 'CRITICAL HIT! 2x damage', color: '#f5c518' })

  // Class bonuses
  if (heroAction.includes('Backstab 3x')) lines.push({ icon: 'dagger', text: 'Backstab: 3x damage multiplier' })
  if (heroAction.includes('Mage critical')) lines.push({ icon: 'mana', text: 'Mage: 1.3x all damage' })
  if (heroAction.includes('Rogue precision')) lines.push({ icon: 'dagger', text: 'Rogue: 1.2x damage' })
  if (heroAction.includes('No mana')) lines.push({ icon: 'mana', text: 'No mana! Half damage', color: '#e74c3c' })

  // Weapon bonus
  if (heroAction.includes('+') && heroAction.includes('wpn')) lines.push({ icon: 'dagger', text: 'Weapon bonus applied' })

  // Loot
  if (heroAction.includes('Dropped')) { const m = heroAction.match(/Dropped (.+?)!/); if (m) lines.push({ icon: 'chest', text: `Loot: ${m[1]}`, color: '#f5c518' }) }
  if (heroAction.includes('mana!')) lines.push({ icon: 'mana', text: '+1 mana (monster kill)', color: '#9b59b6' })

  // Enemy action
  if (enemyAction) {
    const counterMatch = enemyAction.match(/(\d+) (?:total )?damage/)
    if (counterMatch) {
      const hpLost = oldHP - (spec.heroHP ?? 0)
      lines.push({ icon: 'skull', text: enemyAction })
      if (heroAction.includes('Rogue dodged')) lines.push({ icon: 'star', text: 'Rogue dodged the counter-attack!', color: '#2ecc71' })
    } else {
      lines.push({ icon: 'skull', text: enemyAction })
    }
  }

  // Status effects applied
  if (enemyAction.includes('POISON')) lines.push({ icon: 'poison', text: 'Poisoned! -5 HP/turn for 3 turns', color: '#2ecc71' })
  if (enemyAction.includes('BURN')) lines.push({ icon: 'fire', text: 'Burning! -8 HP/turn for 2 turns', color: '#e74c3c' })
  if (enemyAction.includes('STUN')) lines.push({ icon: 'lightning', text: 'Stunned! Skip next attack', color: '#f1c40f' })

  // Kill / victory
  if (dmgMatch && dmgMatch[3] === '0') lines.push({ icon: 'skull', text: 'Target slain!', color: '#f5c518' })
  if (enemyAction.includes('defeated')) lines.push({ icon: 'crown', text: 'BOSS DEFEATED!', color: '#f5c518' })

  return (
    <div className="combat-breakdown">
      {lines.map((l, i) => (
        <div key={i} className="combat-line" style={{ color: l.color }}>
          <span className="combat-icon"><PixelIcon name={l.icon} size={14} /></span>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  )
}

function DiceRoller({ formula }: { formula: string }) {
  const d = parseDice(formula)
  const [faces, setFaces] = useState<number[]>(() => rollDice(d.count, d.sides))
  useEffect(() => {
    const id = setInterval(() => setFaces(rollDice(d.count, d.sides)), 100)
    return () => clearInterval(id)
  }, [d.count, d.sides])
  return (
    <div className="dice-roller">
      <div className="dice-label">🎲 Rolling {formula}...</div>
      <div className="dice-faces">{faces.map((v, i) => <span key={i} className="die rolling">{v}</span>)}</div>
    </div>
  )
}

function parseDice(formula: string): { count: number; sides: number; mod: number } {
  const m = formula.match(/(\d+)d(\d+)\+(\d+)/)
  return m ? { count: +m[1], sides: +m[2], mod: +m[3] } : { count: 2, sides: 10, mod: 8 }
}

function rollDice(count: number, sides: number): number[] {
  return Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1)
}

// EntityCard was removed: the arena renders monsters/boss inline in DungeonView
// for precise layout control. No duplicate logic — each component is rendered once.
