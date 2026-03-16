import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { DungeonSummary, DungeonCR, listDungeons, getDungeon, createDungeon, createNewGamePlus, submitAttack, deleteDungeon, ApiError, LeaderboardEntry, getLeaderboard, UserProfile, getProfile, awardCert, reportError, trackEvent, getMe, logout, AuthUser } from './api'
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
import { KubectlTerminal } from './KubectlTerminal'

// ─── Reconcile Stream types (#462) ───────────────────────────────────────────
interface FieldDiff {
  path: string
  old: string
  new: string
  cel?: string
  rgd?: string
  concept?: string
}

interface ReconcileDiffEvent {
  resource: string
  kind: string
  resourceVersion: string
  action: string
  fields: FieldDiff[]
  dungeonName: string
  dungeonNamespace: string
  ts: string  // wall-clock timestamp added by frontend on receipt
}

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
    { id: 'speedrun', name: 'Speedrunner', icon: 'lightning', earned: turns <= 30, desc: `Won in ${turns} turns (≤30 needed)` },
    { id: 'deathless', name: 'Untouchable', icon: 'shield', earned: heroHP >= Math.floor(maxHeroHP * 0.8), desc: `Finished with ${heroHP}/${maxHeroHP} HP (80% needed)` },
    { id: 'pacifist', name: 'Potionist', icon: 'potion', earned: weaponBonus === 0, desc: 'Won without equipping a weapon' },
    { id: 'warrior-win', name: 'War Chief', icon: 'sword', earned: heroClass === 'warrior', desc: 'Won as Warrior' },
    { id: 'mage-win', name: 'Archmage', icon: 'mana', earned: heroClass === 'mage', desc: 'Won as Mage' },
    { id: 'rogue-win', name: 'Shadow', icon: 'dagger', earned: heroClass === 'rogue', desc: 'Won as Rogue' },
    { id: 'hard-win', name: 'Nightmare', icon: 'skull', earned: difficulty === 'hard', desc: 'Won on Hard difficulty' },
    { id: 'collector', name: 'Hoarder', icon: 'chest', earned: equippedCount >= 5, desc: `Won with ${equippedCount}/5 items equipped` },
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
            <span className="achievement-icon"><PixelIcon name={a.icon} size={12} /></span>
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
  // #462: Reconcile stream — accumulates RECONCILE_DIFF WebSocket events
  const [reconcileStream, setReconcileStream] = useState<ReconcileDiffEvent[]>([])
  const seenResourceKindsRef = useRef<Set<string>>(new Set())
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

  // Auth state — null = not yet checked, false = not logged in, AuthUser = logged in
  const [authUser, setAuthUser] = useState<AuthUser | null | false>(null)
  const authCheckedRef = useRef(false)
  useEffect(() => {
    if (authCheckedRef.current) return
    authCheckedRef.current = true
    getMe().then(user => {
      setAuthUser(user ?? false)
      // #478: unauthenticated users always see the intro tour, regardless of localStorage
      if (!user) setShowOnboarding(true)
    })
  }, [])

  const handleLogout = useCallback(async () => {
    await logout()
    setAuthUser(false)
    setDungeons([])
    setDetail(null)
    setShowOnboarding(true) // re-show intro on logout
    navigate('/')
  }, [navigate])

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
  const [showProfile, setShowProfile] = useState(false)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  // kro Certificates (#361) — toast + Tier 2 trigger counters
  const [certToast, setCertToast] = useState<string | null>(null)
  const certToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const insightDismissCountRef = useRef(0)
  const glossaryOpenCountRef = useRef(0)
  const reconcileCycleCountRef = useRef(0)
  const reconcileWasActiveRef = useRef(false)
  const celTraceSeenRef = useRef(false)

  const triggerInsight = useCallback((event: string) => {
    const trigger = getInsightForEvent(event)
    if (!trigger) return
    unlock(trigger.conceptId)
    // Only show each concept card once per session
    if (shownInsightsRef.current.has(trigger.conceptId)) return
    shownInsightsRef.current.add(trigger.conceptId)
    setInsightQueue(q => [...q, trigger])
  }, [unlock])

  // Tier 2 certificate trigger (#361) — called from UI interaction callbacks
  const handleCertTrigger = useCallback(async (certId: string) => {
    if (profile?.kroCertificates?.includes(certId)) return // already earned
    const updated = await awardCert(certId)
    if (!updated) return
    setProfile(prev => prev ? { ...prev, kroCertificates: updated } : prev)
    if (!profile?.kroCertificates?.includes(certId)) {
      // Show toast
      if (certToastTimerRef.current) clearTimeout(certToastTimerRef.current)
      setCertToast(certId)
      certToastTimerRef.current = setTimeout(() => setCertToast(null), 4000)
    }
  }, [profile])

  // Auto-surface CEL Playground once the player is engaged (10+ concepts unlocked)
  const playgroundFiredRef = useRef(false)
  useEffect(() => {
    if (!playgroundFiredRef.current && unlocked.size >= 10) {
      playgroundFiredRef.current = true
      setTimeout(() => triggerInsight('cel-playground-unlocked'), 2000)
    }
  }, [unlocked.size, triggerInsight])

  // Track kro-reconcile cycles for cert (#361)
  useEffect(() => {
    if (reconciling) {
      reconcileWasActiveRef.current = true
    } else if (reconcileWasActiveRef.current) {
      reconcileWasActiveRef.current = false
      reconcileCycleCountRef.current += 1
      if (reconcileCycleCountRef.current >= 3) {
        handleCertTrigger('kro-reconcile')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciling])

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
    // #462: Accumulate reconcile-diff events into the stream
    if (lastEvent?.type === 'RECONCILE_DIFF' && lastEvent.payload) {
      const diff = lastEvent.payload as Omit<ReconcileDiffEvent, 'ts'>
      const entry: ReconcileDiffEvent = { ...diff, ts: new Date().toLocaleTimeString() }
      setReconcileStream(prev => [entry, ...prev].slice(0, 200))
      // Auto-trigger InsightCard on first appearance of each new resource kind
      const kind = diff.kind?.toLowerCase() ?? ''
      if (kind && !seenResourceKindsRef.current.has(kind)) {
        seenResourceKindsRef.current.add(kind)
        if (kind === 'configmap') triggerInsight('reconcile-loop')
        else if (kind === 'hero') triggerInsight('resource-chaining')
        else if (kind === 'boss') triggerInsight('boss-phase')
        else if (kind === 'loot') triggerInsight('loot-system')
        else if (kind === 'modifier') triggerInsight('modifier-present')
      }
      return
    }
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
      setReconcileStream([])
      seenResourceKindsRef.current = new Set()
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

  const handleCreate = async (name: string, monsters: number, difficulty: string, heroClass: string, onSuccess: () => void) => {
    setError('')
    try {
      await createDungeon(name, monsters, difficulty, heroClass, 'default')
      trackEvent('dungeon_created', { monsters, difficulty, heroClass })
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
      onSuccess() // clear the form only on success (#490)
      navigate(`/dungeon/default/${name}`)
    } catch (e: any) { reportError('create-dungeon', e); setError(e.message) }
  }

  const addEvent = (icon: string, msg: string) => {
    setEvents(prev => [{ type: 'COMBAT', action: icon, name: msg, namespace: '', payload: null }, ...prev].slice(0, 30))
  }

  const [floatingDmg, setFloatingDmg] = useState<{ target: string; amount: string; color: string } | null>(null)
  const [bossPhaseFlash, setBossPhaseFlash] = useState<'enraged' | 'berserk' | null>(null)

  const [combatModal, setCombatModal] = useState<{ phase: 'rolling' | 'resolved'; formula: string; heroAction: string; enemyAction: string; spec: any; oldHP: number } | null>(null)
  const pendingLootRef = useRef<string | null>(null)

  const handleAttack = async (target: string, damage: number) => {
    if (!selected || attackPhase || attackingRef.current) { console.log('[onAttack] early return: selected=', !!selected, 'attackPhase=', attackPhase, 'ref=', attackingRef.current); return }
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
      // Track interaction for CloudWatch game event log
      if (isItem) {
        trackEvent('item_used', { item: target, heroClass: detail?.spec.heroClass })
      } else if (isAbility) {
        trackEvent('action_used', { action: target, heroClass: detail?.spec.heroClass })
      } else {
        trackEvent('attack_submitted', { target: shortTarget, heroClass: detail?.spec.heroClass, difficulty: detail?.spec.difficulty })
      }
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
        // Poll until actionSeq > prevSeq AND lastAction is cleared (kro finished processing).
        // The backend writes trigger fields (lastAction, actionSeq, etc.) and kro's
        // actionResolve specPatch computes the actual state mutations, then clears lastAction.
        // For enter-room-2: also wait for room2ProcessedSeq to advance (enterRoom2Resolve fires
        // on the next reconcile after actionResolve sets currentRoom=2).
        const prevSeq = detail?.spec.actionSeq ?? 0
        if (target === 'enter-room-2') setRoomLoading(true)
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise(r => setTimeout(r, 1500))
          const current = await getDungeon(selected.ns, selected.name)
          const seqAdvanced = (current.spec.actionSeq || 0) > prevSeq && !current.spec.lastAction
          const room2Ready = target !== 'enter-room-2' || (current.spec.room2ProcessedSeq || 0) >= (current.spec.actionSeq || 0)
          if (seqAdvanced && room2Ready) {
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
        if (target === 'enter-room-2') {
          triggerInsight('enter-room-2')
          // #444: K8s log entry for room transition — enterRoom2Resolve specPatch fired
          const newMonHP = updated.spec.room2MonsterHP?.join(',') ?? '...'
          const newBossHP = updated.spec.room2BossHP ?? '...'
          addK8s(
            `kubectl patch dungeon ${selected.name} --type=merge -p '{"spec":{"currentRoom":2}}'`,
            `enterRoom2Resolve specPatch fired — monsterHP: [${newMonHP}], bossHP: ${newBossHP}`,
            `# dungeon-graph.yaml — enterRoom2Resolve specPatch\ntype: specPatch\npatch:\n  currentRoom: "2"\n  monsterHP: "<scaled ×1.5 via CEL>"\n  bossHP: "<scaled ×1.3 via CEL>"`
          )
        }
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

        // Poll until attackSeq > prevSeq AND all kro triggers are cleared:
        // - lastAttackTarget cleared by combatResolve (normal combat)
        // - lastAbility cleared by abilityResolve (mage heal, warrior taunt)
        // The backend writes trigger fields and kro's specPatch nodes compute
        // the actual state mutations, then clear the triggers.
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(r => setTimeout(r, 1000))
          const current = await getDungeon(selected.ns, selected.name)
          if ((current.spec.attackSeq || 0) > prevSeq && !current.spec.lastAttackTarget && !current.spec.lastAbility) {
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

      // Loot drop — stash until combat modal is dismissed so it's a surprise
      if (!isItem && pollSucceeded && updated.spec.lastLootDrop) {
        pendingLootRef.current = updated.spec.lastLootDrop
      }
      await new Promise(r => setTimeout(r, 100))

      // Read combat log from Dungeon CR — skip "already dead" non-events
      if (pollSucceeded && heroAction && !heroAction.includes('already dead') && !heroAction.includes('already defeated')) {
        const icon = heroAction.includes('heals') ? 'heal' : heroAction.includes('Taunt') ? 'shield' : heroAction.includes('Backstab') ? 'dagger' : heroAction.includes('STUNNED') ? 'lightning' : 'sword'
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
        // Loot: use lastLootDrop from spec (kro-authoritative), not Go log text
        if (pollSucceeded && updated.spec.lastLootDrop && updated.spec.lastLootDrop !== detail?.spec.lastLootDrop) {
          addEvent('chest', `Loot dropped: ${updated.spec.lastLootDrop}`)
        }
        // Kill detection: use actual monsterHP spec change, not Go log text
          if (pollSucceeded) {
            const prevMonHP: number[] = detail?.spec.monsterHP || []
            const newMonHP: number[] = updated.spec.monsterHP || []
            newMonHP.forEach((hp, idx) => {
              if (hp <= 0 && (prevMonHP[idx] ?? 1) > 0) {
                const displayName = getMonsterName(idx, updated.spec.currentRoom || 1, updated.spec.monsterTypes)
                addEvent('skull', `${displayName} slain!`)
              }
            })
          }
      }
      if (pollSucceeded && enemyAction) {
        const eIcon = enemyAction.includes('POISON') ? 'poison' : enemyAction.includes('BURN') ? 'fire' : enemyAction.includes('STUN') ? 'lightning' : enemyAction.includes('defeated') ? 'crown' : 'skull'
        addEvent(eIcon, enemyAction)
      }
      // State change events (only if poll succeeded and state actually changed)
      if (pollSucceeded) {
        const prevBossHP = detail?.spec.bossHP ?? 1
        const newBossHP = updated.spec.bossHP ?? 1
        const prevAllDead = (detail?.spec.monsterHP || []).every((hp: number) => hp <= 0)
        const nowAllDead = (updated.spec.monsterHP || []).every((hp: number) => hp <= 0)
        if (nowAllDead && !prevAllDead) { addEvent('dragon', 'Boss unlocked! All monsters slain!'); triggerInsight('boss-ready'); triggerInsight('all-monsters-dead') }
        if (newBossHP <= 0 && prevBossHP > 0) { addEvent('crown', 'VICTORY! Boss defeated!'); triggerInsight('boss-killed') }
        // Boss phase transitions
        const prevMaxBossHP = Number(detail?.status?.maxBossHP) || (prevBossHP > 0 ? prevBossHP : 1)
        const newMaxBossHP = Number(updated.status?.maxBossHP) || prevMaxBossHP
        const prevPct = newMaxBossHP > 0 ? (prevBossHP / newMaxBossHP) * 100 : 100
        const newPct = newMaxBossHP > 0 ? (newBossHP / newMaxBossHP) * 100 : 100
        if (prevPct > 50 && newPct <= 50 && newBossHP > 0) {
          addEvent('fire', 'The boss becomes ENRAGED! (Phase 2: ×1.3 damage)')
          setBossPhaseFlash('enraged')
          setTimeout(() => setBossPhaseFlash(null), 1500)
          // #444: K8s log entry for boss phase change — boss-graph CEL fired
          addK8s(
            `kubectl get cm ${selected?.name ?? '...'}-boss -n ${selected?.ns ?? '...'}`,
            `bossPhase: phase2, damageMultiplier: 13 (1.3×)`,
            `# boss-graph.yaml — damageMultiplier specPatch (phase2)\nphase: "\${hp * 100 / maxHP > 50 ? 'phase1' : hp * 100 / maxHP > 25 ? 'phase2' : 'phase3'}"\ndamageMultiplier: "\${... > 50 ? '10' : ... > 25 ? '13' : '16'}"  # ×10 integer`
          )
        }
        if (prevPct > 25 && newPct <= 25 && newBossHP > 0) {
          addEvent('skull', 'BERSERK MODE! Boss attacks with fury! (Phase 3: ×1.6 damage)')
          setBossPhaseFlash('berserk')
          setTimeout(() => setBossPhaseFlash(null), 1500)
          // #444: K8s log entry for boss phase change — boss-graph CEL fired
          addK8s(
            `kubectl get cm ${selected?.name ?? '...'}-boss -n ${selected?.ns ?? '...'}`,
            `bossPhase: phase3, damageMultiplier: 16 (1.6×)`,
            `# boss-graph.yaml — damageMultiplier specPatch (phase3)\nphase: "\${hp * 100 / maxHP > 50 ? 'phase1' : hp * 100 / maxHP > 25 ? 'phase2' : 'phase3'}"\ndamageMultiplier: "\${... > 50 ? '10' : ... > 25 ? '13' : '16'}"  # ×10 integer`
          )
        }
        if ((updated.spec.heroHP ?? 100) <= 0 && (detail?.spec.heroHP ?? 100) > 0) addEvent('skull', 'Hero has fallen...')
        // DoT floating damage on hero
        const prevHeroHP = detail?.spec.heroHP ?? 100
        const newHeroHP = updated.spec.heroHP ?? 100
        const hpDropped = newHeroHP < prevHeroHP
        const prevPoisonTurns = detail?.spec.poisonTurns ?? 0
        const prevBurnTurns = detail?.spec.burnTurns ?? 0
        const newPoisonTurns = updated.spec.poisonTurns ?? 0
        const newBurnTurns = updated.spec.burnTurns ?? 0
        // Detect tickDoT specPatch: poisonTurns or burnTurns actually decremented
        // (#500: use counter decrement as the reliable signal — HP drop can be obscured by simultaneous counter-attack)
        const dotTicked = (prevPoisonTurns > 0 && newPoisonTurns < prevPoisonTurns) || (prevBurnTurns > 0 && newBurnTurns < prevBurnTurns)
        if (dotTicked) {
          // Show floating damage for the DoT portion
          const dotDmg = (prevPoisonTurns > 0 && newPoisonTurns < prevPoisonTurns ? 5 : 0) + (prevBurnTurns > 0 && newBurnTurns < prevBurnTurns ? 8 : 0)
          if (hpDropped && dotDmg > 0) {
            const color = prevPoisonTurns > 0 ? '#2ecc71' : '#e74c3c'
            setFloatingDmg({ target: 'hero', amount: `-${dotDmg}`, color })
            setTimeout(() => setFloatingDmg(null), 1200)
          }
          // #450/#500: fire spec-patch insight on tickDoT — tickDoT is a specPatch node that writes heroHP/poisonTurns/burnTurns back to spec
          triggerInsight('dot-applied')
        }
        // Detect monster kill
        const prevDeadCount = (detail?.spec.monsterHP || []).filter((hp: number) => hp <= 0).length
        const newDeadCount = (updated.spec.monsterHP || []).filter((hp: number) => hp <= 0).length
        if (newDeadCount > prevDeadCount) triggerInsight('monster-killed')
        // First attack
        if ((detail?.spec.attackSeq ?? 0) === 0 && (updated.spec.attackSeq ?? 0) > 0) triggerInsight('first-attack')
        // Second attack — teach the reconcile loop concept
        if ((detail?.spec.attackSeq ?? 0) === 1 && (updated.spec.attackSeq ?? 0) > 1) triggerInsight('second-attack')
        // #459: class-specific deep dive triggers
        if (heroAction.includes('Taunt activated')) triggerInsight('warrior-taunt-used')
        if (heroAction.includes('heals for')) triggerInsight('mage-heal-used')
        if (enemyAction.includes('dodged') || heroAction.includes('Rogue dodged')) triggerInsight('rogue-dodge-fired')
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
        reportError('attack', e)
        setError(e.message)
      }
      setCombatModal(null)
      setAttackPhase(null)
      setReconciling(false)
      setAnimPhase('idle')
      setAttackTarget(null)
      setFloatingDmg(null)
      attackingRef.current = false
      pendingLootRef.current = null
    }
  }

  const dismissCombat = () => {
    setCombatModal(null)
    setAttackPhase(null)
    setAnimPhase('idle')
    setAttackTarget(null)
    attackingRef.current = false
    // Reveal loot now that the player has seen the combat result
    if (pendingLootRef.current) {
      setLootDrop(pendingLootRef.current)
      triggerInsight('loot-drop')
      setTimeout(() => triggerInsight('loot-drop-string-ops'), 4000)
      // #444: K8s log entry for loot drop — includeWhen: hp==0 creates Loot CR
      const lootStr = pendingLootRef.current
      if (lootStr) {
        const [itemType, rarity] = lootStr.split('-')
        addK8s(
          `kubectl get loot -n ${selected?.ns ?? '...'} -l game.k8s.example/dungeon=${selected?.name ?? '...'}`,
          `loot CR created — includeWhen: hp==0 fired in monster-graph`,
          `# monster-graph.yaml — Loot CR (includeWhen: hp==0)\n- id: lootCR\n  includeWhen:\n    - "\${schema.spec.hp <= 0}"\n  template:\n    kind: Loot\n    spec:\n      itemType: ${itemType ?? '?'}\n      rarity: ${rarity ?? '?'}`
        )
      }
      pendingLootRef.current = null
    }
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
      trackEvent('dungeon_deleted', { outcome: detail?.status?.victory ? 'victory' : detail?.status?.defeated ? 'defeat' : 'in-progress', totalTurns: (detail?.spec.attackSeq ?? 0) + (detail?.spec.actionSeq ?? 0) })
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
    } catch (e: any) { reportError('delete-dungeon', e); setError(e.message); setDeleting(prev => { const s = new Set(prev); s.delete(delName); return s }) }
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

  const handleOpenProfile = async () => {
    setShowProfile(true)
    setProfileLoading(true)
    try {
      const p = await getProfile()
      setProfile(p)
    } catch {
      setProfile(null)
    } finally {
      setProfileLoading(false)
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
      trackEvent('dungeon_created', { monsters: spec.monsters ?? 3, difficulty: spec.difficulty ?? 'normal', heroClass: spec.heroClass ?? 'warrior', runCount })
    } catch (e: any) { reportError('create-new-game-plus', e); setError(e.message) }
  }

  // Auth not yet checked — show nothing to avoid flash
  if (authUser === null) {
    return <div className="app"><div className="loading">Checking session...</div></div>
  }

  // Not logged in — show login screen
  if (authUser === false) {
    return (
      <div className="app">
        <header className="header">
          <img src="/logo.png" alt="Kubernetes RPG" className="logo" />
          <p>Powered by kro ResourceGraphDefinitions on EKS</p>
        </header>
        <div className="card" style={{ textAlign: 'center', padding: '32px 16px', maxWidth: 400, margin: '40px auto' }}>
          <div style={{ fontSize: '10px', color: 'var(--gold)', marginBottom: 16 }}>Your Dungeon is a Kubernetes CR</div>
          <div style={{ fontSize: '8px', color: 'var(--text-dim)', marginBottom: 24, lineHeight: 1.8 }}>
            Dungeon state lives in EKS. kro drives the resource graph. You drive the hero.
          </div>
          <a href="/api/v1/auth/login" className="btn btn-gold" style={{ display: 'inline-block', textDecoration: 'none', fontSize: '8px' }}>
            Login with GitHub
          </a>
        </div>
      </div>
    )
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
        {authUser && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <img src={authUser.avatarUrl} alt={authUser.login} width={20} height={20} style={{ borderRadius: '50%', border: '1px solid var(--gold)' }} />
            <span style={{ fontSize: '7px', color: 'var(--text-dim)' }}>@{authUser.login}</span>
          </div>
        )}
      </header>

      {error && <div className="card" style={{ borderColor: '#e94560', color: '#e94560', fontSize: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{error}</span>
        <button aria-label="Dismiss error" onClick={() => setError('')} style={{ background: 'none', border: 'none', color: '#e94560', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px' }}>✕</button>
      </div>}

      {!selected ? (
        <>
          {showOnboarding && <KroOnboardingOverlay onDismiss={() => setShowOnboarding(false)} isAuthenticated={!!authUser} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <div style={{ position: 'relative' }}>
              <button className="hamburger-btn" aria-label="Menu" onClick={() => setShowHamburger(v => !v)}>☰</button>
              {showHamburger && (
                <>
                  <div className="hamburger-backdrop" onClick={() => setShowHamburger(false)} />
                  <div className="hamburger-menu">
                    <button className="hamburger-item" onClick={() => { setShowHamburger(false); handleOpenLeaderboard() }}>Leaderboard</button>
                    <button className="hamburger-item" onClick={() => { setShowHamburger(false); setShowOnboarding(true) }}>About kro</button>
                    {authUser && <button className="hamburger-item" onClick={() => { setShowHamburger(false); handleOpenProfile() }}>Profile @{authUser.login}</button>}
                    {authUser && <button className="hamburger-item" onClick={() => { setShowHamburger(false); handleLogout() }}>Logout @{authUser.login}</button>}
                  </div>
                </>
              )}
            </div>
          </div>
          <CreateForm onCreate={(n, m, d, c, onSuccess) => handleCreate(n, m, d, c, onSuccess)} />
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
          {authUser && (
            <div style={{ textAlign: 'center', marginTop: 8, fontSize: '7px', color: 'var(--text-dim)' }}>
              Your dungeon data is kept for 4 hours.
            </div>
          )}
        </>
      ) : loading ? (
        <div className="loading">Initializing dungeon</div>
      ) : detail && (detail.spec.initProcessedSeq ?? 0) === 0 ? (
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
          reconcileStream={reconcileStream}
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
          onCertTrigger={handleCertTrigger}
          glossaryOpenCountRef={glossaryOpenCountRef}
          celTraceSeenRef={celTraceSeenRef}
        />
      ) : null}

      {/* kro Insight Cards — slide in from bottom-right */}
      {insightQueue.length > 0 && (
        <InsightCard
          trigger={insightQueue[0]}
          onDismiss={() => {
            setInsightQueue(q => q.slice(1))
            insightDismissCountRef.current += 1
            if (insightDismissCountRef.current >= 3) {
              handleCertTrigger('insight-card')
            }
          }}
          onViewConcept={setKroConceptModal}
        />
      )}

      {/* kro Certificate toast (#361) */}
      {certToast && (() => {
        const def = CERT_REGISTRY.find(c => c.id === certToast)
        return (
          <div className="cert-toast" aria-live="polite" data-testid="cert-toast">
            <PixelIcon name={def?.icon ?? 'star'} size={14} />
            <div>
              <div className="cert-toast-title">kro Certificate Earned!</div>
              <div className="cert-toast-name">{def?.name ?? certToast}</div>
            </div>
          </div>
        )
      })()}

      {/* Leaderboard — rendered globally so it works from any screen */}
      {showLeaderboard && (
        <LeaderboardPanel entries={leaderboard} loading={leaderboardLoading} onClose={() => setShowLeaderboard(false)} />
      )}

      {showProfile && (
        <ProfilePanel profile={profile} loading={profileLoading} authUser={authUser || null} onClose={() => setShowProfile(false)} />
      )}

      {/* Help Modal — rendered globally so z-index is unaffected by DungeonView subtree (#495) */}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} onCheat={() => { setShowHelp(false); setTimeout(() => setShowCheat(true), 100) }} />}

      {/* kro Concept Modal */}
      {kroConceptModal && (
        <KroConceptModal conceptId={kroConceptModal} onClose={() => setKroConceptModal(null)} />
      )}
    </div>
  )
}

function CreateForm({ onCreate }: { onCreate: (n: string, m: number, d: string, c: string, onSuccess: () => void) => void }) {
  const [name, setName] = useState('')
  const [monsters, setMonsters] = useState(3)
  const [difficulty, setDifficulty] = useState('normal')
  const [heroClass, setHeroClass] = useState('warrior')
  const dnsLabelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
  const nameValid = name === '' || dnsLabelRegex.test(name)
  const monstersValid = monsters >= 1 && monsters <= 10
  const canCreate = name.length > 0 && dnsLabelRegex.test(name) && monstersValid
  return (
    <div className="create-form">
      <div>
        <label>Dungeon Name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="my-dungeon"
          maxLength={63}
          pattern="[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?"
        />
        {!nameValid && <div className="input-error">Name: lowercase letters, numbers, hyphens only. Max 63 chars. Must start and end with alphanumeric.</div>}
      </div>
      <div>
        <label>Monsters</label>
        <input type="number" min={1} max={10} value={monsters} onChange={e => setMonsters(+e.target.value)} />
        {!monstersValid && <div className="input-error">Monsters: must be between 1 and 10.</div>}
      </div>
      <div><label>Difficulty</label>
        <select value={difficulty} onChange={e => setDifficulty(e.target.value)}>
          <option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option>
        </select>
      </div>
      <div><label>Hero Class</label>
        <select value={heroClass} onChange={e => setHeroClass(e.target.value)}>
          <option value="warrior">Warrior</option><option value="mage">Mage</option><option value="rogue">Rogue</option>
        </select>
      </div>
      <button className="btn btn-gold" disabled={!canCreate} onClick={() => { if (canCreate) { onCreate(name, monsters, difficulty, heroClass, () => setName('')) } }}>
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
              <span className="tag ng-plus-badge" title={`New Game+ run #${d.runCount}`}>NG+{d.runCount}</span>
            )}
            <span>Monsters: {d.livingMonsters ?? '?'}</span>
            <span>Boss: {d.bossState === 'pending' ? 'Locked' : d.bossState === 'ready' ? 'Ready' : d.bossState === 'defeated' ? 'Defeated' : d.bossState ?? '?'}</span>
            {d.modifier && d.modifier !== 'none' && (
              <span className={`tag tag-modifier-${d.modifier.startsWith('curse') ? 'curse' : 'blessing'}`} title={d.modifier}>
                {d.modifier.startsWith('curse') ? '[!]' : '+'} {d.modifier.replace(/^(curse|blessing)-/, '')}
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

const CLASS_ICON: Record<string, string> = { warrior: 'sword', mage: 'mana', rogue: 'dagger' }

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
                <th>Player</th>
                <th>Class</th>
                <th>Difficulty</th>
                <th>Turns</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.timestamp}-${e.dungeonName}`} className="lb-row lb-victory">
                  <td className="lb-rank">{i + 1}</td>
                  <td className="lb-name">{e.dungeonName}</td>
                  <td><PixelIcon name={CLASS_ICON[e.heroClass] ?? 'sword'} size={10} /></td>
                  <td><span className={`tag tag-${e.difficulty}`}>{e.difficulty}</span></td>
                  <td className="lb-turns">{e.totalTurns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: '7px', color: 'var(--text-dim)', marginTop: 8, textAlign: 'center' }}>
          Victory runs only, sorted by fewest turns. Stored in the <code>krombat-leaderboard</code> ConfigMap in <code>rpg-system</code>.
        </div>
      </div>
    </div>
  )
}

const BADGE_LABELS: Record<string, string> = {
  speedrun: 'Speedrunner', deathless: 'Untouchable', pacifist: 'Potionist',
  'warrior-win': 'War Chief', 'mage-win': 'Archmage', 'rogue-win': 'Shadow',
  'hard-win': 'Nightmare', collector: 'Hoarder',
  'room2-winner': 'Dungeon Diver', 'no-damage': 'Flawless', 'multi-class': 'Versatile',
  reaper: 'Reaper', legend: 'Legend', 'new-game-plus': 'Ascendant',
  'no-potions': 'Iron Will', 'full-kit': 'Fully Loaded',
}
const BADGE_ICONS: Record<string, string> = {
  speedrun: 'lightning', deathless: 'shield', pacifist: 'potion',
  'warrior-win': 'sword', 'mage-win': 'mana', 'rogue-win': 'dagger',
  'hard-win': 'skull', collector: 'chest',
  'room2-winner': 'chest', 'no-damage': 'shield', 'multi-class': 'crown',
  reaper: 'skull', legend: 'crown', 'new-game-plus': 'lightning',
  'no-potions': 'heart', 'full-kit': 'armor',
}
const ALL_BADGES = Object.keys(BADGE_LABELS)

// ─── kro Certificate Registry (#361) ─────────────────────────────────────────
interface CertDef {
  id: string; name: string; tier: 1 | 2 | 3
  hint: string    // shown when not yet earned
  icon: string    // PixelIcon name
}
const CERT_REGISTRY: CertDef[] = [
  // Tier 1 — Observer (awarded automatically by backend on run completion)
  { id: 'first-dungeon',      name: 'Dungeon Architect',       tier: 1, icon: 'helm',    hint: 'Create your first dungeon (a Kubernetes CR!)' },
  { id: 'cel-state',          name: 'CEL State Machine',       tier: 1, icon: 'mana',    hint: 'Win a dungeon (kro CEL computed victory=true)' },
  { id: 'two-rooms',          name: 'Graph Traverser',         tier: 1, icon: 'door',    hint: 'Clear both rooms (traverse the full resource graph)' },
  { id: 'loot-system',        name: 'Resource Graph Explorer', tier: 1, icon: 'chest',   hint: 'Equip 3+ different item types in one run' },
  // Tier 2 — Practitioner (awarded by POST /api/v1/profile/cert from frontend interactions)
  { id: 'log-explorer',       name: 'Log Explorer',            tier: 2, icon: 'scroll',  hint: 'Open the K8s Log Tab for the first time' },
  { id: 'kro-reconcile',      name: 'kro Watcher',             tier: 2, icon: 'book',    hint: 'Watch 3 kro reconciliation cycles in a dungeon' },
  { id: 'cel-trace',          name: 'CEL Tracer',              tier: 2, icon: 'book',    hint: 'View a CelTrace in the combat log' },
  { id: 'insight-card',       name: 'Insight Reader',          tier: 2, icon: 'star',    hint: 'Dismiss 3 InsightCards in one dungeon run' },
  { id: 'glossary',           name: 'Glossary Scholar',        tier: 2, icon: 'scroll',  hint: 'Open 5 glossary terms from the kro tab' },
  { id: 'graph-panel',        name: 'Graph Viewer',            tier: 2, icon: 'crown',   hint: 'Open the kro resource graph panel' },
  // Tier 3 — Architect (awarded automatically by backend on run completion)
  { id: 'boss-phase',         name: 'Phase Controller',        tier: 3, icon: 'sword',   hint: 'Win a dungeon fighting boss through all 3 phases' },
  { id: 'modifier-master',    name: 'Modifier Master',         tier: 3, icon: 'skull',   hint: 'Win on Hard with a Curse modifier active' },
  { id: 'new-game-plus-cert', name: 'Ascendant Architect',     tier: 3, icon: 'crown',   hint: 'Win a New Game+ run' },
  { id: 'cel-scholar',        name: 'CEL Scholar',             tier: 3, icon: 'mana',    hint: 'Reach Level 5 (XP system)' },
  { id: 'dungeon-master',     name: 'Dungeon Master',          tier: 3, icon: 'trophy',  hint: 'Win 5 dungeons total across different classes' },
]
const TIER_LABELS: Record<number, string> = { 1: 'Tier 1 — Observer', 2: 'Tier 2 — Practitioner', 3: 'Tier 3 — Architect' }

function ProfilePanel({ profile, loading, authUser, onClose }: {
  profile: UserProfile | null; loading: boolean; authUser: AuthUser | null; onClose: () => void
}) {
  const login = authUser?.login ?? 'anonymous'
  const avatarUrl = authUser?.avatarUrl ?? ''
  const earnedSet = new Set(profile?.earnedBadges ?? [])
  const inventoryItems = profile?.inventory ? profile.inventory.split(',').filter(Boolean) : []

  return (
    <div className="leaderboard-overlay" role="dialog" aria-label="Player Profile">
      <div className="leaderboard-panel" style={{ maxWidth: 500, width: '95%' }}>
        <div className="leaderboard-header">
          <span className="leaderboard-title">Profile</span>
          <button className="modal-close leaderboard-close" aria-label="Close profile" onClick={onClose}>✕</button>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 16, fontSize: '8px', color: 'var(--text-dim)' }}>Loading...</div>
        ) : (
          <div style={{ padding: '4px 0' }}>
            {/* Identity row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              {avatarUrl && <img src={avatarUrl} alt="" style={{ width: 28, height: 28, borderRadius: 2, imageRendering: 'pixelated' }} />}
              <span style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-bright)' }}>@{login}</span>
              {profile && profile.level > 0 && (
                <span style={{ fontSize: '7px', color: 'var(--text-dim)', marginLeft: 'auto' }}>
                  Level {profile.level} — {profile.xp} XP
                </span>
              )}
            </div>

            {/* XP progress bar (#360) */}
            {profile && profile.level > 0 && (() => {
              const XP_THRESHOLDS = [0, 100, 250, 500, 1000, 2000, 3500, 5500, 8000, 12000]
              const LEVEL_TITLES = ['Adventurer', 'Initiate', 'Dungeon Runner', 'Monster Slayer', 'Boss Hunter', 'Dungeon Veteran', 'Elite Delver', 'Master Delver', 'Kro Wielder', 'Dungeon Architect']
              const lvl = profile.level
              const title = LEVEL_TITLES[lvl - 1] ?? 'Dungeon Architect'
              const currentXP = profile.xp
              const thisLvlXP = XP_THRESHOLDS[lvl - 1] ?? 0
              const nextLvlXP = XP_THRESHOLDS[lvl] ?? null
              const pct = nextLvlXP ? Math.min(100, ((currentXP - thisLvlXP) / (nextLvlXP - thisLvlXP)) * 100) : 100
              return (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '7px', color: 'var(--text-dim)', marginBottom: 3 }}>
                    <span style={{ color: 'var(--gold)' }}>Lv.{lvl} {title}</span>
                    {nextLvlXP ? (
                      <span>{currentXP} / {nextLvlXP} XP → Lv.{lvl + 1}</span>
                    ) : (
                      <span style={{ color: 'var(--gold)' }}>MAX LEVEL</span>
                    )}
                  </div>
                  <div style={{ background: 'var(--border)', borderRadius: 2, height: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, background: 'var(--gold)', height: '100%', transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              )
            })()}

            {/* Lifetime stats */}
            {profile ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: '8px', marginBottom: 10 }}>
                  <span><span style={{ color: 'var(--text-dim)' }}>Played:</span> {profile.dungeonsPlayed}</span>
                  <span><span style={{ color: 'var(--text-dim)' }}>Won:</span> {profile.dungeonsWon}</span>
                  <span><span style={{ color: 'var(--text-dim)' }}>Lost:</span> {profile.dungeonsLost}</span>
                  <span><span style={{ color: 'var(--text-dim)' }}>Abandoned:</span> {profile.dungeonsAbandoned}</span>
                  <span><span style={{ color: 'var(--text-dim)' }}>Total turns:</span> {profile.totalTurns}</span>
                  <span><span style={{ color: 'var(--text-dim)' }}>Kills:</span> {profile.totalKills}</span>
                  <span><span style={{ color: 'var(--text-dim)' }}>Boss kills:</span> {profile.totalBossKills}</span>
                  {profile.favouriteClass && (
                    <span><span style={{ color: 'var(--text-dim)' }}>Favourite:</span> {profile.favouriteClass} / {profile.favouriteDifficulty}</span>
                  )}
                </div>

                {/* Persistent backpack */}
                {inventoryItems.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: '7px', color: 'var(--text-dim)', marginBottom: 4, letterSpacing: '0.05em' }}>PERSISTENT BACKPACK</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {inventoryItems.map((item, i) => (
                        <div key={i} title={item} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: 'var(--panel-bg)', border: '1px solid var(--border)', padding: '4px 6px', borderRadius: 2 }}>
                          <ItemSprite id={item} size={20} />
                          <span style={{ fontSize: '6px', color: 'var(--text-dim)' }}>{item.replace('-', ' ')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Badges */}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: '7px', color: 'var(--text-dim)', marginBottom: 4, letterSpacing: '0.05em' }}>
                    BADGES — {earnedSet.size} / {ALL_BADGES.length}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {ALL_BADGES.map(id => {
                      const earned = earnedSet.has(id)
                      const count = profile.badgeCounts?.[id] ?? 0
                      return (
                        <div key={id}
                          title={BADGE_LABELS[id] + (earned && count > 1 ? ` ×${count}` : '') + (earned ? '' : ' — not yet earned')}
                          style={{
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                            background: 'var(--panel-bg)', border: `1px solid ${earned ? 'var(--gold)' : 'var(--border)'}`,
                            padding: '4px 6px', borderRadius: 2, opacity: earned ? 1 : 0.35,
                            minWidth: 44,
                          }}
                          aria-label={`badge: ${BADGE_LABELS[id]}${earned ? ' earned' : ''}`}
                        >
                          <PixelIcon name={BADGE_ICONS[id] ?? 'star'} size={12} />
                          <span style={{ fontSize: '6px', color: earned ? 'var(--text-bright)' : 'var(--text-dim)', textAlign: 'center' }}>
                            {BADGE_LABELS[id]}{earned && count > 1 ? ` ×${count}` : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* kro Certificates — grouped by tier (#361) */}
                <div>
                  {[1, 2, 3].map(tier => {
                    const tierCerts = CERT_REGISTRY.filter(c => c.tier === tier)
                    const earnedCerts = new Set(profile.kroCertificates ?? [])
                    const earnedCount = tierCerts.filter(c => earnedCerts.has(c.id)).length
                    return (
                      <div key={tier} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: '7px', color: 'var(--text-dim)', marginBottom: 4, letterSpacing: '0.05em' }}>
                          {TIER_LABELS[tier]} — {earnedCount}/{tierCerts.length}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {tierCerts.map(cert => {
                            const earned = earnedCerts.has(cert.id)
                            return (
                              <div key={cert.id}
                                title={earned ? cert.name : cert.hint}
                                aria-label={`cert: ${cert.name}${earned ? ' earned' : ''}`}
                                data-testid={`cert-${cert.id}${earned ? '-earned' : ''}`}
                                style={{
                                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                                  background: 'var(--panel-bg)', border: `1px solid ${earned ? '#00d4ff' : 'var(--border)'}`,
                                  padding: '4px 6px', borderRadius: 2, opacity: earned ? 1 : 0.35,
                                  minWidth: 52,
                                }}
                              >
                                <PixelIcon name={cert.icon} size={12} />
                                <span style={{ fontSize: '6px', color: earned ? '#00d4ff' : 'var(--text-dim)', textAlign: 'center', maxWidth: 60 }}>
                                  {cert.name}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <div style={{ fontSize: '8px', color: 'var(--text-dim)', textAlign: 'center', padding: 12 }}>
                No profile data yet. Complete a dungeon run to start tracking your progress.
              </div>
            )}

            <div style={{ fontSize: '7px', color: 'var(--text-dim)', marginTop: 10, textAlign: 'center' }}>
              Stored in the <code>krombat-profiles</code> ConfigMap in <code>rpg-system</code>.
            </div>
          </div>
        )}
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
function EventLogTabs({ events, k8sLog, reconcileStream, kroUnlocked, onViewKroConcept, dungeonNs, dungeonName, showPlayground, onOpenPlayground, onClosePlayground, onCertTrigger, glossaryOpenCountRef }: {
  events: WSEvent[]
  k8sLog: { ts: string; cmd: string; res: string; yaml?: string }[]
  reconcileStream: ReconcileDiffEvent[]
  kroUnlocked: Set<KroConceptId>
  onViewKroConcept: (id: KroConceptId) => void
  dungeonNs?: string
  dungeonName?: string
  showPlayground: boolean
  onOpenPlayground: () => void
  onClosePlayground: () => void
  onCertTrigger?: (certId: string) => void  // Tier 2 cert callbacks (#361)
  glossaryOpenCountRef?: MutableRefObject<number>
}) {
  const [tab, setTab] = useState<'game' | 'k8s' | 'reconcile' | 'kro'>('game')
  const [yamlModal, setYamlModal] = useState<{ yaml: string; cmd: string } | null>(null)
  const [kroConceptModal, setKroConceptModal] = useState<KroConceptId | null>(null)
  const k8sTabOpenedRef = useRef(false)
  // #462: Reconcile Stream — pause + expanded "Why?" per entry
  const [paused, setPaused] = useState(false)
  const [pausedSnapshot, setPausedSnapshot] = useState<ReconcileDiffEvent[]>([])
  const [expandedWhy, setExpandedWhy] = useState<string | null>(null) // key = `${ts}-${resource}`

  const handleTabChange = (newTab: 'game' | 'k8s' | 'reconcile' | 'kro') => {
    setTab(newTab)
    // Tier 2 cert: first time K8s log tab is opened (#361)
    if (newTab === 'k8s' && !k8sTabOpenedRef.current) {
      k8sTabOpenedRef.current = true
      onCertTrigger?.('log-explorer')
    }
    // Reconcile stream: pause/resume when switching away/to
    if (newTab === 'reconcile') {
      setPaused(false)
      setPausedSnapshot([])
    }
  }

  // When paused, freeze the displayed list
  const displayedStream = paused ? pausedSnapshot : reconcileStream

  const handlePause = () => {
    if (paused) {
      setPaused(false)
      setPausedSnapshot([])
    } else {
      setPausedSnapshot(reconcileStream)
      setPaused(true)
    }
  }

  const handleCopyJson = () => {
    const data = JSON.stringify(displayedStream, null, 2)
    navigator.clipboard.writeText(data).catch(() => {})
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="log-tabs">
        <button className={`log-tab${tab === 'game' ? ' active' : ''}`} onClick={() => handleTabChange('game')}>Game Log</button>
        <button className={`log-tab${tab === 'k8s' ? ' active' : ''}`} onClick={() => handleTabChange('k8s')}>K8s Log</button>
        <button className={`log-tab reconcile-tab${tab === 'reconcile' ? ' active' : ''}`} onClick={() => handleTabChange('reconcile')}>
          Reconcile Stream{reconcileStream.length > 0 ? ` (${reconcileStream.length})` : ''}
        </button>
        <button className={`log-tab kro-tab${tab === 'kro' ? ' active' : ''}`} onClick={() => handleTabChange('kro')}>
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
              <span className="event-icon"><PixelIcon name={e.action} size={10} /></span>
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
      ) : tab === 'reconcile' ? (
        <div className="reconcile-stream-panel">
          <div className="reconcile-stream-controls">
            <button className={`reconcile-btn${paused ? ' paused' : ''}`} onClick={handlePause}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button className="reconcile-btn" onClick={handleCopyJson} title="Copy full stream as JSON">
              Copy JSON
            </button>
            {paused && <span className="reconcile-paused-label">Paused</span>}
          </div>
          <div className="event-log reconcile-log" aria-live="polite" aria-label="Reconcile stream">
            {displayedStream.length === 0 && (
              <div className="event-entry reconcile-empty">
                No reconcile events yet — play a combat turn to see kro in action.
              </div>
            )}
            {displayedStream.map((entry, i) => {
              const entryKey = `${entry.ts}-${entry.resource}-${i}`
              // Only show diffs that have actual changes (exclude tombstone ~ entries with no useful info)
              const meaningfulFields = entry.fields.filter(f => f.path !== '~' || entry.action === 'DELETED')
              if (meaningfulFields.length === 0 && entry.action !== 'DELETED') return null
              return (
                <div key={entryKey} className="reconcile-entry">
                  <div className="reconcile-header">
                    <span className="reconcile-ts">{entry.ts}</span>
                    <span className={`reconcile-action reconcile-action-${entry.action.toLowerCase()}`}>{entry.action}</span>
                    <span className="reconcile-resource">{entry.resource}</span>
                    <span className="reconcile-rv">rv:{entry.resourceVersion}</span>
                  </div>
                  {meaningfulFields.map((fd, fi) => {
                    const fieldKey = `${entryKey}-${fi}`
                    const isFieldExpanded = expandedWhy === fieldKey
                    const color = fd.new === '' ? '#e74c3c'  // deleted/cleared
                      : fd.old === '' ? '#2ecc71'            // added
                      : fd.new > fd.old ? '#2ecc71'          // increased (numeric-ish)
                      : fd.new < fd.old ? '#e74c3c'          // decreased
                      : '#f1c40f'                            // changed (non-numeric)
                    return (
                      <div key={fi} className="reconcile-field" style={{ borderLeft: `2px solid ${color}` }}>
                        <span className="reconcile-path">{fd.path}:</span>
                        {fd.old !== '' && <span className="reconcile-old">{fd.old}</span>}
                        {fd.old !== '' && <span className="reconcile-arrow"> → </span>}
                        <span className="reconcile-new" style={{ color }}>{fd.new !== '' ? fd.new : '(removed)'}</span>
                        {(fd.cel || fd.rgd) && (
                          <button
                            className="reconcile-why-btn"
                            onClick={() => setExpandedWhy(isFieldExpanded ? null : fieldKey)}
                            title="Why? — see the kro CEL expression"
                          >Why?</button>
                        )}
                        {isFieldExpanded && (fd.cel || fd.rgd) && (
                          <div className="reconcile-why-panel">
                            {fd.rgd && <div className="reconcile-why-rgd">RGD: {fd.rgd}</div>}
                            {fd.cel && <pre className="reconcile-why-cel">{fd.cel}</pre>}
                            {fd.concept && (
                              <button
                                className="k8s-annotation-learn"
                                onClick={() => {
                                  setExpandedWhy(null)
                                  onViewKroConcept(fd.concept as KroConceptId)
                                }}
                              >
                                Learn: {fd.concept} →
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div>
          <KroGlossary unlocked={kroUnlocked} onViewConcept={id => {
            setKroConceptModal(id)
            // Tier 2: glossary cert after 5 terms opened (#361)
            if (glossaryOpenCountRef) {
              glossaryOpenCountRef.current += 1
              if (glossaryOpenCountRef.current >= 5) {
                onCertTrigger?.('glossary')
              }
            }
          }} />
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
        <h2 style={{ color: '#e94560', fontSize: 12, marginBottom: 8 }}><PixelIcon name="damage" size={10} /> CHEAT MODE</h2>
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
    if (s === 'cleared') return `R${n} [ok]`
    if (s === 'boss-active') return `R${n} [!]`
    if (s === 'locked') return `R${n} [L]`
    return `R${n}`
  }

  return (
    <div className="dungeon-minimap" aria-label="Dungeon progress map">
      <div className="minimap-room" style={{ borderColor: stateColor(r1State), color: stateColor(r1State) }}>
        {stateLabel(r1State, 1)}
        {r1State === 'cleared' && treasureOpened === 0 && (
          <span className="minimap-icon" title="Treasure available"><PixelIcon name="chest" size={10} /></span>
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
        <p>Each dungeon spawns with a random modifier (90% chance).</p>
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
    { title: 'Loot & Equipment', content: (
      <>
        <p>Monsters drop items on death. Boss always drops rare/epic loot. Click items in backpack to use or equip. Inventory cap: 8 items.</p>
        <table className="help-table">
          <thead><tr><th>Item</th><th>Common</th><th>Rare</th><th>Epic</th></tr></thead>
          <tbody>
            <tr><td><PixelIcon name="sword" size={10} /> Weapon</td><td>+5 dmg (3 uses)</td><td>+10 dmg (3 uses)</td><td>+20 dmg (3 uses)</td></tr>
            <tr><td><PixelIcon name="shield" size={10} /> Armor</td><td>+10% def</td><td>+20% def</td><td>+30% def</td></tr>
            <tr><td><PixelIcon name="shield" size={10} /> Shield</td><td>10% block</td><td>15% block</td><td>25% block</td></tr>
            <tr><td><PixelIcon name="helmet" size={10} /> Helmet</td><td>+5% crit</td><td>+10% crit</td><td>+15% crit</td></tr>
            <tr><td><PixelIcon name="pants" size={10} /> Pants</td><td>+5% dodge</td><td>+10% dodge</td><td>+15% dodge</td></tr>
            <tr><td><PixelIcon name="boots" size={10} /> Boots</td><td>20% resist</td><td>40% resist</td><td>60% resist</td></tr>
            <tr><td><PixelIcon name="ring" size={10} /> Ring</td><td>+5 HP/round</td><td>+8 HP/round</td><td>+12 HP/round</td></tr>
            <tr><td><PixelIcon name="amulet" size={10} /> Amulet</td><td>+10% dmg</td><td>+20% dmg</td><td>+30% dmg</td></tr>
            <tr><td><PixelIcon name="heart" size={10} /> HP Potion</td><td>+20 HP</td><td>+40 HP</td><td>Full heal</td></tr>
            <tr><td><PixelIcon name="mana" size={10} /> Mana Potion</td><td>+2 mana</td><td>+3 mana</td><td>+8 mana (Mage only)</td></tr>
          </tbody>
        </table>
        <p>Drop chance: Easy ≈61%, Normal ≈44%, Hard ≈36%</p>
      </>
    )},
    { title: 'Status Effects', content: (
      <>
        <p>Enemies can inflict status effects during counter-attacks. Effects apply at the start of your next turn.</p>
        <table className="help-table">
          <thead><tr><th>Effect</th><th>Source</th><th>Duration</th><th>Damage</th></tr></thead>
          <tbody>
            <tr><td><PixelIcon name="poison" size={10} /> Poison</td><td>Monsters (20%), Bat-boss (30%)</td><td>3 turns</td><td>-5 HP/turn</td></tr>
            <tr><td><PixelIcon name="fire" size={10} /> Burn</td><td>Dragon boss (25%)</td><td>2 turns</td><td>-8 HP/turn</td></tr>
            <tr><td><PixelIcon name="lightning" size={10} /> Stun</td><td>Boss (15%), Archers (20%)</td><td>1 turn</td><td>Skip attack</td></tr>
          </tbody>
        </table>
        <p>Effects don't stack — new application is blocked while active. Boots provide status resistance.</p>
      </>
    )},
    { title: 'Boss Phases & Room 2', content: (
      <>
        <p>The boss has three phases based on remaining HP. Higher phases deal more counter-attack damage.</p>
        <table className="help-table">
          {/* #452: Counter Mult fixed to 1.3x/1.6x (was 1.5x/2.0x); Special Chance replaced with actual hardcoded
              status effect rates from dungeon-graph combatResolve specPatch (not driven by specialAttackChance) */}
          <thead><tr><th>Phase</th><th>HP Range</th><th>Counter Mult</th><th>Burn</th><th>Stun</th><th>Poison (R2)</th></tr></thead>
          <tbody>
            <tr><td>Normal</td><td>&gt;50%</td><td>1.0×</td><td>25%</td><td>15%</td><td>30%</td></tr>
            <tr><td style={{color:'#e67e22'}}>ENRAGED</td><td>26–50%</td><td>1.3×</td><td>25%</td><td>15%</td><td>30%</td></tr>
            <tr><td style={{color:'#e74c3c'}}>BERSERK</td><td>1–25%</td><td>1.6×</td><td>25%</td><td>15%</td><td>30%</td></tr>
          </tbody>
        </table>
        <p>Status effect chances are fixed regardless of boss phase (computed by <code>combatResolve</code> specPatch in dungeon-graph).</p>
        <p><b>Room 2:</b> After defeating the Room 1 boss, treasure opens and the door unlocks automatically. Click the door to enter Room 2 with trolls, ghouls, and a Bat-boss (stronger than Room 1). Mage mana is fully restored on entry. Defeating the Room 2 boss wins the dungeon.</p>
      </>
    )},
    { title: 'Tips & Strategy', content: (
      <>
        <p><b>General:</b> Kill monsters first to reduce counter-attack damage before engaging the boss.</p>
        <p><b>Warrior:</b> Best for beginners. High HP lets you survive many hits. Use Taunt before big boss attacks.</p>
        <p><b>Mage:</b> Glass cannon. Rush the boss with 1.3x damage. Heal when low. Mana regens on monster kills and is restored when entering Room 2.</p>
        <p><b>Rogue:</b> High risk/reward. Dodge procs can save you. Save Backstab (3x) for the boss.</p>
        <p><b>Items:</b> Equip weapons before attacking the boss. Use potions freely — they don't cost a turn. Boots resist status effects; pants stack dodge with Rogue's passive.</p>
        <p><b>Modifiers:</b> Blessing of Fortune (20% crit) is the strongest. Curse of Fury makes boss fights brutal — especially in BERSERK phase.</p>
      </>
    )},
    { title: 'XP & Levelling', content: (
      <>
        <p>Earn XP during every run. Kill XP is kept even on defeat — only end-of-dungeon bonuses require a win. XP accumulates in the <code>spec.xpEarned</code> field on the Dungeon CR, patched by the backend after each kill.</p>
        <table className="help-table">
          <thead><tr><th>Event</th><th>XP</th></tr></thead>
          <tbody>
            <tr><td>Monster kill</td><td>+10</td></tr>
            <tr><td>Room 1 boss kill</td><td>+50</td></tr>
            <tr><td>Room 1 clear bonus</td><td>+25</td></tr>
            <tr><td>Enter Room 2</td><td>+10</td></tr>
            <tr><td>Room 2 boss kill</td><td>+100</td></tr>
            <tr><td>Room 2 clear bonus</td><td>+25</td></tr>
            <tr><td>Victory bonus</td><td>+150</td></tr>
            <tr><td>Hard difficulty</td><td>+50</td></tr>
            <tr><td>Flawless (full HP)</td><td>+25</td></tr>
            <tr><td>Speedrun (≤30 turns)</td><td>+25</td></tr>
            <tr><td>New Game+</td><td>+50</td></tr>
          </tbody>
        </table>
        <p>Reach <b>Level 10 (Dungeon Architect)</b> at 12,000 career XP. Check your progress bar in the Profile panel.</p>
      </>
    )},
    { title: 'kubectl Terminal', content: (
      <>
        <p>Open the <b>kubectl Terminal</b> from the ☰ menu inside any dungeon. It gives you a real CLI experience — your commands call the actual backend API. No kubectl binary needed.</p>
        <table className="help-table">
          <thead><tr><th>Command</th><th>What it does</th></tr></thead>
          <tbody>
            <tr><td><code>kubectl apply -f dungeon.yaml</code></td><td>Create a new dungeon CR</td></tr>
            <tr><td><code>kubectl get dungeons</code></td><td>List your dungeons</td></tr>
            <tr><td><code>kubectl get dungeon &lt;name&gt;</code></td><td>Show spec fields</td></tr>
            <tr><td><code>kubectl describe dungeon &lt;name&gt;</code></td><td>Verbose output + status</td></tr>
            <tr><td><code>kubectl delete dungeon &lt;name&gt;</code></td><td>Delete a dungeon</td></tr>
            <tr><td><code>cat dungeon.yaml</code></td><td>Show the YAML template</td></tr>
          </tbody>
        </table>
        <p>Every command shows a collapsible <b>[kro] What just happened?</b> block explaining which RGD was triggered and the CEL expression that ran.</p>
        <p>Use ↑↓ arrow keys for command history. Tab to autocomplete dungeon name.</p>
      </>
    )},
    { title: 'Share Run Card', content: (
      <>
        <p>After winning a dungeon, a <b>Run Card</b> is generated — a shareable SVG image showing your hero class, difficulty, turn count, dungeon name, and kro concepts unlocked.</p>
        <p>Click <b>↗ Share Run</b> on the victory screen to copy a ready-to-post tweet + card URL to your clipboard. Anyone with the link can view your card.</p>
        <p>The card URL is served directly by the backend as <code>/api/v1/run-card/&lt;ns&gt;/&lt;name&gt;</code> — a plain SVG. No image hosting required.</p>
        <p>This is one of many ways kro drives awareness: every win becomes a shareable kro impression.</p>
      </>
    )},
    { title: 'Reconcile Stream', content: (
      <>
        <p>The <b>Reconcile Stream</b> tab shows raw Kubernetes watch events as a live diff view — every field kro changes during a combat turn, in real time.</p>
        <p>Each entry shows the resource that changed (e.g. <code>configmap/my-dungeon-monster-0</code>), its new resource version, and a field-level diff:</p>
        <table className="help-table">
          <thead><tr><th>Color</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td style={{color:'#2ecc71'}}>Green</td><td>Field added or value increased</td></tr>
            <tr><td style={{color:'#e74c3c'}}>Red</td><td>Field removed or value decreased</td></tr>
            <tr><td style={{color:'#f1c40f'}}>Yellow</td><td>Field changed (non-numeric)</td></tr>
          </tbody>
        </table>
        <p>Click <b>Why?</b> on any field to expand the kro CEL expression responsible for that change, which RGD it lives in, and a link to the full concept card.</p>
        <p>Use <b>Pause</b> to freeze the stream while reading. Use <b>Copy JSON</b> to export the full event log for debugging.</p>
      </>
    )},
    { title: 'Blog Post Generator', content: (
      <>
        <p>After winning, click <b>Tell the story of this run</b> on the victory screen to generate a shareable Markdown blog post about your run.</p>
        <p>The post includes:</p>
        <ul>
          <li>Hero class, difficulty, turn count, and dungeon name</li>
          <li>Narrated kro events — boss phase transitions, loot drops, room transitions — each with the responsible CEL expression and RGD</li>
          <li>All kro concepts you unlocked, linked to the kro docs</li>
          <li>The full Dungeon CR YAML snippet</li>
          <li>A CTA linking to <code>learn-kro.eks.aws.dev</code></li>
        </ul>
        <p><b>Copy Markdown</b> copies the post to your clipboard. <b>Open in GitHub Discussions</b> opens a new tab pre-filled in the kro repo's show-and-tell category.</p>
      </>
    )},
  ]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" role="dialog" aria-modal="true" aria-label={`Help: ${pages[page].title}`} onClick={e => e.stopPropagation()}>
        <h2 style={{ color: 'var(--gold)', fontSize: 12, marginBottom: 4 }}><PixelIcon name="book" size={10} /> {pages[page].title}</h2>
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

function DungeonView({ cr, prevCr, onBack, onNewGamePlus, onAttack, events, k8sLog, reconcileStream, showLoot, onOpenLoot, onCloseLoot, attackPhase, roomLoading, animPhase, attackTarget, showHelp, onToggleHelp, showCheat, onToggleCheat, floatingDmg, bossPhaseFlash, combatModal, onDismissCombat, lootDrop, onDismissLoot, wsConnected, apiError, kroUnlocked, onViewKroConcept, reconciling, onOpenLeaderboard, onCertTrigger, glossaryOpenCountRef, celTraceSeenRef }: {
  cr: DungeonCR; prevCr?: DungeonCR | null; onBack: () => void; onNewGamePlus?: () => void; onAttack: (t: string, d: number) => void; events: WSEvent[]; k8sLog: { ts: string; cmd: string; res: string; yaml?: string }[]; reconcileStream: ReconcileDiffEvent[]
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
  onCertTrigger?: (certId: string) => void  // Tier 2 cert callbacks (#361)
  glossaryOpenCountRef?: MutableRefObject<number>
  celTraceSeenRef?: MutableRefObject<boolean>
}) {
  if (!cr?.metadata?.name) return <div className="loading">Loading dungeon</div>
  const spec = cr.spec || { monsters: 0, difficulty: 'normal', monsterHP: [], bossHP: 0, heroHP: 100 }
  const status = cr.status
  const dungeonName = cr.metadata.name
  const maxMonsterHP = Number(status?.maxMonsterHP) || Math.max(...(spec.monsterHP || [1]))
  const maxBossHP = Number(status?.maxBossHP) || spec.bossHP
  const heroHP = spec.heroHP ?? 100
  const classMaxHP = spec.heroClass === 'warrior' ? 200 : spec.heroClass === 'mage' ? 120 : 150
  const maxHeroHP = Number(status?.maxHeroHP) || classMaxHP
  const isDefeated = status?.defeated || heroHP <= 0
  const allMonstersDead = (spec.monsterHP || []).every((hp: number) => hp <= 0)
  const bossState = spec.bossHP <= 0 ? 'defeated' : allMonstersDead ? 'ready' : 'pending'
  // Boss phase — always derive from HP % (instant, no kro lag), status is only used when HP is 0
  const bossPhase: 'phase1' | 'phase2' | 'phase3' | 'defeated' = (() => {
    if (spec.bossHP <= 0) return 'defeated'
    if (maxBossHP > 0) {
      const pct = (spec.bossHP / maxBossHP) * 100
      if (pct <= 25) return 'phase3'
      if (pct <= 50) return 'phase2'
    }
    return 'phase1'
  })()
  const gameOver = isDefeated || (spec.bossHP <= 0 && allMonstersDead)
  // room2BossHP > 0 guards against the brief kro reconciliation window where currentRoom=2
  // but enterRoom2Resolve hasn't fired yet (monsterHP/bossHP still show Room 1 cleared state)
  const isVictory = gameOver && !isDefeated && (spec.currentRoom || 1) === 2 && (spec.room2BossHP || 0) > 0

  // XP earned breakdown for the victory/defeat screen (#360)
  const xpRunBreakdown = (() => {
    const earned = spec.xpEarned ?? 0
    const kills = (spec.monsterHP || []).filter((hp: number) => hp <= 0).length
    const bossR1Dead = (spec.currentRoom || 1) >= 2 || spec.bossHP <= 0
    const bossR2Dead = (spec.currentRoom || 1) === 2 && spec.bossHP <= 0
    const rows: { label: string; xp: number }[] = []
    if (kills > 0) rows.push({ label: `Monster kills (${kills})`, xp: kills * 10 })
    if (bossR1Dead && (spec.currentRoom || 1) === 1) rows.push({ label: 'Boss kill (Room 1)', xp: 50 })
    if ((spec.currentRoom || 1) >= 2) rows.push({ label: 'Room 1 boss kill', xp: 50 })
    if ((spec.currentRoom || 1) >= 2) rows.push({ label: 'Room 1 clear bonus', xp: 25 })
    if ((spec.currentRoom || 1) >= 2) rows.push({ label: 'Enter Room 2', xp: 10 })
    if (bossR2Dead) rows.push({ label: 'Room 2 boss kill', xp: 100 })
    if (bossR2Dead) rows.push({ label: 'Room 2 clear bonus', xp: 25 })
    if (isVictory) {
      rows.push({ label: 'Victory bonus', xp: 150 })
      if (spec.difficulty === 'hard') rows.push({ label: 'Hard difficulty', xp: 50 })
      if (spec.heroHP >= classMaxHP) rows.push({ label: 'Flawless (full HP)', xp: 25 })
      if ((spec.attackSeq ?? 0) + (spec.actionSeq ?? 0) <= 30) rows.push({ label: 'Speedrun (≤30 turns)', xp: 25 })
      if ((spec.runCount ?? 0) >= 1) rows.push({ label: 'New Game+', xp: 50 })
    }
    // Use actual spec.xpEarned as the source of truth (backend is authoritative)
    return { rows, total: earned }
  })()
  const [showCertificate, setShowCertificate] = useState(false)
  const [showDungeonHamburger, setShowDungeonHamburger] = useState(false)
  const [showPlayground, setShowPlayground] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)  // #457 kubectl terminal
  const [shareCopied, setShareCopied] = useState(false)   // #456 run card share feedback
  const [showNarrative, setShowNarrative] = useState(false)   // #460 blog post generator
  const [narrativeText, setNarrativeText] = useState('')       // #460
  const [narrativeLoading, setNarrativeLoading] = useState(false)  // #460
  const [narrativeCopied, setNarrativeCopied] = useState(false)    // #460
  // Auto-show certificate once on room-2 victory
  const certShownRef = useRef(false)
  useEffect(() => {
    if (isVictory && !certShownRef.current) {
      certShownRef.current = true
      setTimeout(() => setShowCertificate(true), 800)
    }
  }, [isVictory])

  // Tier 2: cel-trace cert — fire once when CelTrace is rendered in combat results (#361)
  useEffect(() => {
    if (combatModal && combatModal.phase !== 'rolling' && combatModal.heroAction) {
      if (celTraceSeenRef && !celTraceSeenRef.current) {
        celTraceSeenRef.current = true
        onCertTrigger?.('cel-trace')
      }
    }
  }, [combatModal, celTraceSeenRef, onCertTrigger])

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

  // XP popup: show "+N XP" floating text when spec.xpEarned increases (#360)
  const prevXpRef = useRef<number>(spec.xpEarned ?? 0)
  const [xpPopup, setXpPopup] = useState<{ amount: number; key: number } | null>(null)
  useEffect(() => {
    const prev = prevXpRef.current
    const curr = spec.xpEarned ?? 0
    if (curr > prev) {
      setXpPopup({ amount: curr - prev, key: Date.now() })
      setTimeout(() => setXpPopup(null), 1200)
    }
    prevXpRef.current = curr
  }, [spec.xpEarned])

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
  const turnOrder: { id: string; label: string; alive: boolean }[] = [{ id: 'hero', label: 'Hero', alive: !isDefeated }]
  ;(spec.monsterHP || []).forEach((hp, i) => {
    turnOrder.push({ id: `monster-${i}`, label: `M${i}`, alive: hp > 0 })
  })
  if (bossState !== 'pending') {
    turnOrder.push({ id: 'boss', label: 'Boss', alive: bossState === 'ready' })
  }

  return (
    <div>
       <div className="dungeon-header">
         <h2><PixelIcon name="sword" size={14} /> {dungeonName}{spec.runCount != null && spec.runCount > 0 ? <span className="ng-plus-badge" style={{ fontSize: '6px', marginLeft: 6 }}>NG+{spec.runCount}</span> : null}</h2>
         <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
           <button className="help-btn" aria-label="Help" onClick={onToggleHelp}>?</button>
            <div style={{ position: 'relative' }}>
              <button className="hamburger-btn" aria-label="Menu" onClick={() => setShowDungeonHamburger(v => !v)}>☰</button>
              {showDungeonHamburger && (
                <>
                  <div className="hamburger-backdrop" onClick={() => setShowDungeonHamburger(false)} />
                  <div className="hamburger-menu">
                    <button className="hamburger-item" onClick={() => { setShowDungeonHamburger(false); onOpenLeaderboard() }}>Leaderboard</button>
                    <button className="hamburger-item" onClick={() => { setShowDungeonHamburger(false); setShowPlayground(true) }}>CEL Playground</button>
                    <button className="hamburger-item" onClick={() => { setShowDungeonHamburger(false); setShowTerminal(t => !t) }}>
                      {showTerminal ? 'Hide Terminal' : '⌨ kubectl Terminal'}
                    </button>
                  </div>
                </>
              )}
            </div>
           <button className="back-btn" onClick={onBack}>← Back</button>
         </div>
       </div>

       {/* ── Mini-map ─────────────────────────────────────────────────── */}
       <DungeonMiniMap spec={spec} />

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
          {(spec.stunTurns ?? 0) > 0 ? (
            <span className="turn-indicator" style={{ color: '#f1c40f' }}><PixelIcon name="stun" size={12} /> STUNNED — skipping this turn</span>
          ) : (
            <span className="turn-indicator"><PixelIcon name="sword" size={12} /> Ready to attack!</span>
          )}
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
            {spec.weaponBonus ? <span><PixelIcon name="sword" size={8} /> Weapon +{spec.weaponBonus}</span> : null}
            {spec.armorBonus ? <span><PixelIcon name="shield" size={8} /> Armor {spec.armorBonus}%</span> : null}
            {spec.ringBonus ? <span><PixelIcon name="ring" size={8} /> Ring +{spec.ringBonus}/turn</span> : null}
            {spec.amuletBonus ? <span><PixelIcon name="amulet" size={8} /> Amulet +{spec.amuletBonus}%dmg</span> : null}
          </div>
          {xpRunBreakdown.total > 0 && (
            <div className="xp-summary">
              <div className="xp-summary-title">XP Earned This Run</div>
              {xpRunBreakdown.rows.map(r => (
                <div key={r.label} className="xp-summary-row">
                  <span>{r.label}</span><span style={{ color: 'var(--gold)' }}>+{r.xp}</span>
                </div>
              ))}
              <div className="xp-summary-total">Total: +{xpRunBreakdown.total} XP</div>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button className="btn" style={{ fontSize: 7 }} onClick={onBack}>← New Dungeon</button>
          </div>
        </div>
      )}

      {gameOver && !isDefeated && (spec.currentRoom || 1) === 2 && (spec.room2BossHP || 0) > 0 && (
        <div className="victory-banner">
          <h2><PixelIcon name="crown" size={18} /> VICTORY! <PixelIcon name="crown" size={18} /></h2>
          <p className="loot">The dungeon has been conquered!</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', margin: '8px 0', fontSize: 7, color: 'var(--text-dim)' }}>
            <span>Turns: <span style={{ color: 'var(--gold)' }}>{spec.attackSeq ?? 0}</span></span>
            <span>Hero: <span style={{ color: 'var(--gold)' }}>{spec.heroClass ?? 'warrior'}</span></span>
            <span>Difficulty: <span style={{ color: 'var(--gold)' }}>{spec.difficulty}</span></span>
            {spec.weaponBonus ? <span><PixelIcon name="sword" size={8} /> Weapon +{spec.weaponBonus}</span> : null}
            {spec.armorBonus ? <span><PixelIcon name="shield" size={8} /> Armor {spec.armorBonus}%</span> : null}
            {spec.helmetBonus ? <span><PixelIcon name="helmet" size={8} /> Helmet +{spec.helmetBonus}%crit</span> : null}
            {spec.pantsBonus ? <span><PixelIcon name="pants" size={8} /> Pants +{spec.pantsBonus}%dodge</span> : null}
            {spec.ringBonus ? <span><PixelIcon name="ring" size={8} /> Ring +{spec.ringBonus}/turn</span> : null}
            {spec.amuletBonus ? <span><PixelIcon name="amulet" size={8} /> Amulet +{spec.amuletBonus}%dmg</span> : null}
          </div>
          {xpRunBreakdown.total > 0 && (
            <div className="xp-summary">
              <div className="xp-summary-title">XP Earned This Run</div>
              {xpRunBreakdown.rows.map(r => (
                <div key={r.label} className="xp-summary-row">
                  <span>{r.label}</span><span style={{ color: 'var(--gold)' }}>+{r.xp}</span>
                </div>
              ))}
              <div className="xp-summary-total">Total: +{xpRunBreakdown.total} XP</div>
            </div>
          )}
          <AchievementBadges achievements={computeAchievements(spec, spec.heroClass === 'mage' ? 120 : spec.heroClass === 'rogue' ? 150 : 200)} />

          {/* #456 — Run card: shareable SVG generated by backend */}
          {(() => {
            const ns = cr.metadata.namespace ?? 'default'
            const cardUrl = `/api/v1/run-card/${ns}/${dungeonName}?concepts=${kroUnlocked.size}`
            const absoluteCardUrl = `https://learn-kro.eks.aws.dev${cardUrl}`
            const tweetText = `I just conquered a dungeon in @kroio powered by kro on Kubernetes! 🗡️ Hero: ${spec.heroClass ?? 'warrior'} | Difficulty: ${spec.difficulty ?? 'normal'} | Turns: ${spec.attackSeq ?? 0} | kro concepts unlocked: ${kroUnlocked.size}/24\n\nPlay it yourself: https://learn-kro.eks.aws.dev`
            const handleShare = async () => {
              try {
                await navigator.clipboard.writeText(`${tweetText}\n\n${absoluteCardUrl}`)
                setShareCopied(true)
                setTimeout(() => setShareCopied(false), 2500)
              } catch {
                // fallback: prompt
                window.prompt('Copy share text:', `${tweetText}\n\n${absoluteCardUrl}`)
              }
            }
            return (
              <div className="run-card-section">
                <img
                  src={cardUrl}
                  alt={`Run card for ${dungeonName}: ${spec.heroClass} ${spec.difficulty} in ${spec.attackSeq} turns`}
                  className="run-card-img"
                  loading="lazy"
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button
                    className="btn run-card-share-btn"
                    onClick={handleShare}
                    title="Copy shareable tweet + card link to clipboard"
                  >
                    {shareCopied ? '✓ Copied!' : '↗ Share Run'}
                  </button>
                  <button
                    className="btn run-narrative-btn"
                    onClick={async () => {
                      setNarrativeLoading(true)
                      setShowNarrative(true)
                      setNarrativeText('')
                      try {
                        const conceptsList = Array.from(kroUnlocked).join(',')
                        const res = await fetch(`/api/v1/run-narrative/${ns}/${dungeonName}?concepts=${conceptsList}`, { credentials: 'include' })
                        if (!res.ok) throw new Error(`HTTP ${res.status}`)
                        const data = await res.json()
                        setNarrativeText(data.markdown || '')
                      } catch (e: any) {
                        setNarrativeText(`# Error\n\nFailed to generate narrative: ${e?.message ?? 'unknown error'}`)
                      } finally {
                        setNarrativeLoading(false)
                      }
                    }}
                    title="Generate a shareable Markdown blog post about this run"
                  >
                    Tell the story
                  </button>
                </div>
              </div>
            )
          })()}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 8 }}>
            <button className="btn btn-gold" style={{ fontSize: 7 }} onClick={() => setShowCertificate(true)}>
              View kro Certificate →
            </button>
            {onNewGamePlus && (
              <button className="btn btn-gold" style={{ fontSize: 7, borderColor: '#00ff41', color: '#00ff41', background: 'rgba(0,255,65,0.08)' }} onClick={onNewGamePlus}>
                <PixelIcon name="star" size={10} /> New Game+
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
          onClose={() => setShowCertificate(false)}
        />
      )}

      {/* #460 — Blog post / run narrative modal */}
      {showNarrative && (
        <div className="modal-overlay" onClick={() => setShowNarrative(false)}>
          <div className="modal run-narrative-modal" role="dialog" aria-modal="true" aria-label="Run narrative" onClick={e => e.stopPropagation()}>
            <h2 style={{ color: 'var(--gold)', fontSize: 11, marginBottom: 8 }}>Tell the story of this run</h2>
            {narrativeLoading ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-dim)', fontSize: 9 }}>Generating narrative...</div>
            ) : (
              <>
                <textarea
                  className="run-narrative-textarea"
                  readOnly
                  value={narrativeText}
                  aria-label="Generated Markdown blog post"
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-gold"
                    style={{ fontSize: 7 }}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(narrativeText)
                        setNarrativeCopied(true)
                        setTimeout(() => setNarrativeCopied(false), 2500)
                      } catch {
                        window.prompt('Copy Markdown:', narrativeText)
                      }
                    }}
                  >
                    {narrativeCopied ? '✓ Copied!' : 'Copy Markdown'}
                  </button>
                  <button
                    className="btn"
                    style={{ fontSize: 7 }}
                    onClick={() => {
                      const body = encodeURIComponent(narrativeText)
                      window.open(`https://github.com/kubernetes-sigs/kro/discussions/new?category=show-and-tell&body=${body}`, '_blank', 'noopener')
                    }}
                    title="Open a new GitHub Discussion pre-filled with this post"
                  >
                    Open in GitHub Discussions
                  </button>
                  <button className="btn" style={{ fontSize: 7 }} onClick={() => setShowNarrative(false)}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
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
             <div className="arena-entity door-entity" style={{ top: '8%', left: '50%', cursor: (spec.doorUnlocked ?? 0) === 1 ? 'pointer' : 'default' }}
               role={(spec.doorUnlocked ?? 0) === 1 ? 'button' : undefined}
               tabIndex={(spec.doorUnlocked ?? 0) === 1 ? 0 : undefined}
               aria-label={(spec.doorUnlocked ?? 0) === 1 ? 'Enter Room 2' : undefined}
                onClick={() => {
                  if (attackPhase) return
                  if ((spec.doorUnlocked ?? 0) === 1) onAttack('enter-room-2', 0)
                }}>
               {(() => {
                 const doorUnlocked = (spec.doorUnlocked ?? 0) === 1
                 const unlocking = (spec.treasureOpened ?? 0) === 1 && !doorUnlocked
                 return <>
                   <img src={`/sprites/dungeon/door-${doorUnlocked ? 'opened' : 'closed'}.png`}
                     alt="door" style={{ width: 64, height: 64, imageRendering: 'pixelated' as any, filter: doorUnlocked ? 'drop-shadow(0 0 6px #f5c518)' : 'none' }} />
                   {unlocking && <div style={{ fontSize: 7, color: '#aaa', textAlign: 'center', marginTop: 2 }}>Unlocking...</div>}
                   {doorUnlocked && <div style={{ fontSize: 7, color: 'var(--gold)', textAlign: 'center', marginTop: 2 }}>Enter</div>}
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
                  <div style={{ fontSize: 7, color: 'var(--gold)', textAlign: 'center', marginTop: 4, textShadow: '1px 1px 2px #000' }}><PixelIcon name="key" size={8} /> {status.loot}</div>
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
                      {bossPhaseFlash === 'enraged' ? 'ENRAGED!' : 'BERSERK!'}
                    </div>
                  )}
                  {bossState === 'ready' && bossPhase !== 'phase1' && (
                    <div className={`boss-phase-badge ${bossPhase}`}>
                      {bossPhase === 'phase2' ? 'ENRAGED' : 'BERSERK'}
                    </div>
                  )}
                   <Sprite spriteType={(spec.currentRoom || 1) === 2 ? 'bat-boss' : 'dragon'} action={bAction} size={144} />
                   <div className="arena-shadow" style={{ width: 120 }} />
                   {bossState === 'ready' && !gameOver && !attackPhase && (
                     <div className="arena-atk-hint">ATK</div>
                   )}
                  <div className="arena-hover-ui">
                    <div className="arena-hp-bar"><div className={`arena-hp-fill ${spec.bossHP > 0 ? 'high' : 'low'}`} style={{ width: `${Math.min((spec.bossHP / maxBossHP) * 100, 100)}%` }} /></div>
                    <div className="arena-name">Boss · {spec.bossHP}/{maxBossHP}</div>
                    {bossState === 'ready' && !gameOver && !attackPhase && (
                      <div className="arena-actions">
                        <button className="btn btn-primary arena-atk-btn" onClick={() => onAttack(bossName, 0)}><PixelIcon name="dice" size={8} /> {status?.diceFormula || '2d12+6'}</button>
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
              if (hp <= 0) return null // hide dead monsters from arena (#498)
              const mName = `${dungeonName}-monster-${idx}`
              const mSprite = getMonsterSprite(idx, spec.currentRoom || 1, spec.monsterTypes)
              const mDisplayName = getMonsterName(idx, spec.currentRoom || 1, spec.monsterTypes)
              let mAction: SpriteAction = 'idle'
              const inCombat = combatModal && (combatModal.phase === 'rolling' || combatModal.phase === 'resolved')
              if (inCombat) mAction = 'attack'
              if (inCombat && attackTarget === mName) mAction = 'attack'

              // Position in semicircle (top arc around hero)
              const angle = count === 1 ? Math.PI / 2 : (Math.PI * 0.2) + (Math.PI * 0.6 / (count - 1)) * idx
              const radiusX = 38 // % from center
              const radiusY = 30
              const cx = 50 + Math.cos(angle) * radiusX
              const cy = 50 - Math.sin(angle) * radiusY
              const facingRight = cx < 50

              return (
                <div key={mName} className="arena-entity monster-entity alive"
                  style={{ left: `${cx}%`, top: `${cy}%` }}
                  role={!gameOver && !attackPhase ? 'button' : undefined}
                  tabIndex={!gameOver && !attackPhase ? 0 : undefined}
                  aria-label={`${mDisplayName} · HP: ${hp}/${maxMonsterHP}`}
                  onKeyDown={!gameOver && !attackPhase ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAttack(mName, 0) } } : undefined}>
                   {floatingDmg?.target === mName && <div className="floating-dmg" style={{ color: '#e94560' }}>{floatingDmg.amount}</div>}
                   <Sprite spriteType={mSprite} action={mAction} size={72} flip={!facingRight} />
                   <div className="arena-shadow" />
                   {!gameOver && !attackPhase && (
                     <div className="arena-atk-hint">ATK</div>
                   )}
                   <div className="arena-hover-ui">
                     <div className="arena-hp-bar"><div className={`arena-hp-fill ${hp > maxMonsterHP * 0.6 ? 'high' : hp > maxMonsterHP * 0.3 ? 'mid' : 'low'}`} style={{ width: `${Math.min((hp / maxMonsterHP) * 100, 100)}%` }} /></div>
                     <div className="arena-name">{mDisplayName} · {hp}/{maxMonsterHP}</div>
                     {!gameOver && !attackPhase && (
                       <div className="arena-actions">
                         <button className="btn btn-primary arena-atk-btn" onClick={() => onAttack(mName, 0)}><PixelIcon name="dice" size={8} /> {status?.diceFormula || '2d12+6'}</button>
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
              {xpPopup && <div key={xpPopup.key} className="floating-xp">+{xpPopup.amount} XP</div>}
              <Sprite spriteType={spec.heroClass || 'warrior'} size={80}
                action={isDefeated ? 'dead' : status?.victory ? 'victory' : (animPhase === 'hero-attack' || (combatModal && combatModal.phase === 'rolling')) ? 'attack' : animPhase === 'enemy-attack' ? 'hurt' : animPhase === 'item-use' ? 'itemUse' : 'idle'} />
              <div className="arena-shadow" style={{ width: 60 }} />
            </div>

            {/* Room transition loading */}
            {roomLoading && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, borderRadius: 12 }}>
                 <div style={{ textAlign: 'center', color: 'var(--gold)', fontSize: 12 }}>[~] Entering Room 2...</div>
              </div>
            )}

            {/* Flying bats — Room 2 only (bat-boss lives here) */}
            {(spec.currentRoom || 1) === 2 && <DungeonBats />}

            {/* Room 1 cleared — 3s celebration overlay */}
            {showRoom1Cleared && (
              <div className="arena-room1-cleared">
                <div className="arena-room1-cleared-text">* ROOM CLEARED! *</div>
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
                          {rb > 0 ? <><PixelIcon name="ring" size={14} /><span className="slot-stat">+{rb}/t</span></> : <PixelIcon name="ring" size={14} color="#333" />}
                        </div>
                      </Tooltip>
                      <Tooltip text={amb > 0 ? `Amulet equipped: +${amb}% to all damage dealt` : 'Amulet — none equipped'}>
                        <div className={`equip-slot${amb > 0 ? ' filled' : ' empty'}`}>
                          {amb > 0 ? <><PixelIcon name="amulet" size={14} /><span className="slot-stat">+{amb}%</span></> : <PixelIcon name="amulet" size={14} color="#333" />}
                        </div>
                      </Tooltip>
                    </div>
                </div>

                <div className="status-row">
                  {modifier !== 'none' && <Tooltip text={`${modifier.startsWith('curse') ? 'Curse' : 'Blessing'}: ${status?.modifier || modifier}`}><div className={`status-badge ${modifier.startsWith('curse') ? 'curse' : 'blessing'}`}><ItemSprite id={modifier} size={18} /></div></Tooltip>}
                  {taunt > 0 && <Tooltip text={taunt === 1 ? 'Taunt ready: next attack has 60% counter-attack reduction' : 'TAUNTING: 60% counter-attack reduction active this turn'}><div className="status-badge effect taunt"><PixelIcon name="shield" size={12} /><span>{taunt === 2 ? 'ACT' : 'ON'}</span></div></Tooltip>}
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

      <KroGraphPanel cr={cr} prevCr={prevCr} reconciling={reconciling} onViewConcept={onViewKroConcept}
        onExpand={() => onCertTrigger?.('graph-panel')} />

      <EventLogTabs events={events} k8sLog={k8sLog} reconcileStream={reconcileStream} kroUnlocked={kroUnlocked} onViewKroConcept={onViewKroConcept}
        dungeonNs={cr.metadata.namespace} dungeonName={cr.metadata.name}
        showPlayground={showPlayground} onOpenPlayground={() => setShowPlayground(true)} onClosePlayground={() => setShowPlayground(false)}
        onCertTrigger={onCertTrigger}
        glossaryOpenCountRef={glossaryOpenCountRef} />

      {/* kubectl Terminal (#457) */}
      {showTerminal && (
        <KubectlTerminal
          dungeonNs={cr.metadata.namespace ?? 'default'}
          dungeonName={cr.metadata.name}
          dungeonCR={cr}
          onClose={() => setShowTerminal(false)}
        />
      )}
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

  // Mana regen on kill (from Go log text — reliable)
  if (heroAction.includes('+1 mana')) lines.push({ icon: 'mana', text: '+1 mana (monster kill)', color: '#9b59b6' })

  // Loot — show from spec.lastLootDrop (kro-authoritative), not from Go log text
  if (spec?.lastLootDrop) lines.push({ icon: 'chest', text: `Loot: ${spec.lastLootDrop}`, color: '#f5c518' })

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

  // Kill / victory — check whether the specific target hit this turn reached 0 HP
  // dmgMatch[3] is the post-attack HP of the target hit this turn; avoids false positives
  // from Room 1 dead monsters persisting in spec.monsterHP for the rest of the dungeon
  const targetKilled = dmgMatch != null && parseInt(dmgMatch[3]) === 0
  if (targetKilled || heroAction.includes('defeated')) lines.push({ icon: 'skull', text: 'Target slain!', color: '#f5c518' })
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
      <div className="dice-label"><PixelIcon name="dice" size={10} /> Rolling {formula}...</div>
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
