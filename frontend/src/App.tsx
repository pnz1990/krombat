import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { DungeonSummary, DungeonCR, listDungeons, getDungeon, createDungeon, submitAttack, deleteDungeon } from './api'
import { useWebSocket, WSEvent } from './useWebSocket'

import { Sprite, getMonsterSprite, SpriteAction, ItemSprite } from './Sprite'
import { PixelIcon } from './PixelIcon'

// 8-bit styled text icons (consistent cross-platform, matches pixel font)
const ICO = {
  attack: '⚔', dice: '⊞', damage: '✦', shield: '◆', heal: '+', dagger: '†',
  skull: '☠', crown: '♛', lock: '▣', trophy: '★', gift: '◈', delete: '✕',
  help: '?', scroll: '▤', mana: '◇', poison: '●', burn: '▲', stun: '■',
  heart: '♥', gem: '♦', sword: '/', armor: '□', potion: '○',
} as const

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
  const [events, setEvents] = useState<WSEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showLoot, setShowLoot] = useState(false)
  const [attackPhase, setAttackPhase] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [lootDrop, setLootDrop] = useState<string | null>(null)
  const [activeNs, setActiveNs] = useState('default')
  const prevInventoryRef = useRef('')
  const [attackTarget, setAttackTarget] = useState<string | null>(null)
  const [animPhase, setAnimPhase] = useState<'idle' | 'hero-attack' | 'enemy-attack' | 'done'>('idle')

  const { connected, lastEvent } = useWebSocket(selected?.ns, selected?.name)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const refresh = useCallback(async () => {
    try {
      setDungeons(await listDungeons())
      const sel = selectedRef.current
      if (sel) {
        const d = await getDungeon(sel.ns, sel.name)
        setDetail(d)
        prevInventoryRef.current = d.spec.inventory || ''
      }
    } catch {}
  }, [])

  // Refresh on WebSocket events — only refresh data, don't add to event log
  useEffect(() => { if (lastEvent) { refresh() } }, [lastEvent, refresh])

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
            if (!cancelled) { setDetail(d); setLoading(false); prevInventoryRef.current = d.spec.inventory || '' }
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

  const handleCreate = async (name: string, monsters: number, difficulty: string, heroClass: string) => {
    setError('')
    try {
      await createDungeon(name, monsters, difficulty, heroClass, activeNs)
      navigate(`/dungeon/${activeNs}/${name}`)
    } catch (e: any) { setError(e.message) }
  }

  const addEvent = (icon: string, msg: string) => {
    setEvents(prev => [{ type: 'COMBAT', action: icon, name: msg, namespace: '', payload: null }, ...prev].slice(0, 30))
  }

  const [floatingDmg, setFloatingDmg] = useState<{ target: string; amount: string; color: string } | null>(null)

  const [combatModal, setCombatModal] = useState<{ phase: 'rolling' | 'resolved'; formula: string; heroAction: string; enemyAction: string; spec: any; oldHP: number } | null>(null)

  const handleAttack = async (target: string, damage: number) => {
    if (!selected || attackPhase) return
    setError('')
    const isAbility = target === 'hero' || target === 'activate-taunt'
    const isItem = target.startsWith('use-') || target.startsWith('equip-') || target === 'open-treasure'
    const shortTarget = (isAbility || isItem) ? target : target.replace(/-backstab$/, '').split('-').slice(-2).join('-')
    try {
      setAttackTarget(target.replace(/-backstab$/, ''))
      setAnimPhase('hero-attack')
      setAttackPhase('attacking')
      const oldHP = detail?.spec.heroHP ?? 100
      const formula = detail?.status?.diceFormula || '2d10+8'

      if (!isAbility && !isItem) {
        setCombatModal({ phase: 'rolling', formula, heroAction: '', enemyAction: '', spec: detail?.spec, oldHP })
      }

      await submitAttack(selected.ns, selected.name, target, damage)

      // Poll for CR update
      let updated = detail!
      for (let attempt = 0; attempt < 20; attempt++) {
        const fetched = await getDungeon(selected.ns, selected.name)
        if (fetched.spec.lastHeroAction !== detail?.spec.lastHeroAction) {
          updated = fetched
          break
        }
        await new Promise(r => setTimeout(r, 1000))
      }
      setDetail(updated)

      const heroAction = updated.spec.lastHeroAction || ''
      const enemyAction = updated.spec.lastEnemyAction || ''

      if (!isAbility && !isItem) {
        // Show resolved combat breakdown
        setCombatModal({ phase: 'resolved', formula, heroAction, enemyAction, spec: updated.spec, oldHP })
        setAnimPhase('enemy-attack')
      } else if (isItem) {
        // Brief item feedback — no combat modal
        setAttackPhase(null)
        setAnimPhase('idle')
        setAttackTarget(null)
      } else {
        const healMatch = heroAction.match(/heals for (\d+)/)
        if (healMatch) setCombatModal({ phase: 'resolved', formula: '', heroAction, enemyAction: 'No counter-attack during ability', spec: updated.spec, oldHP })
        else setCombatModal({ phase: 'resolved', formula: '', heroAction, enemyAction, spec: updated.spec, oldHP })
      }

      // Detect loot drops
      const oldInv = prevInventoryRef.current
      const newInv = updated.spec.inventory || ''
      if (newInv && newInv !== oldInv) {
        const oldItems = oldInv.split(',').filter(Boolean)
        const newItems = newInv.split(',').filter(Boolean)
        const dropped = newItems.filter(item => !oldItems.includes(item))
        if (dropped.length > 0) setLootDrop(dropped[dropped.length - 1])
      }
      prevInventoryRef.current = newInv
      await new Promise(r => setTimeout(r, 100))

      // Read combat log from Dungeon CR
      if (heroAction) {
        const icon = heroAction.includes('heals') ? '💚' : heroAction.includes('Taunt') ? '🛡️' : heroAction.includes('Backstab') ? '🗡️' : heroAction.includes('STUNNED') ? '🟡' : '⚔️'
        addEvent(icon, heroAction)
        if (heroAction.includes('Dropped')) addEvent('🎁', heroAction.split('Dropped')[1]?.trim() || 'Loot dropped!')
        // Kill
        if (heroAction.includes('-> 0)')) {
          const target = heroAction.match(/damage to (\S+)/)?.[1] || 'enemy'
          addEvent('💀', `${target} slain!`)
        }
      }
      if (enemyAction) {
        const eIcon = enemyAction.includes('POISON') ? '🟢' : enemyAction.includes('BURN') ? '🔴' : enemyAction.includes('STUN') ? '🟡' : enemyAction.includes('defeated') ? '👑' : '💀'
        addEvent(eIcon, enemyAction)
      }
      const s = updated.status
      if (s?.victory) addEvent('🏆', 'VICTORY! Boss defeated!')
      else if (s?.bossState === 'ready') addEvent('🐉', 'Boss unlocked! All monsters slain!')
      else if ((updated.spec.heroHP ?? 100) <= 0) addEvent('💀', 'Hero has fallen...')

      // Don't clear attackPhase — user must dismiss combat modal
      setAnimPhase('idle')
      setAttackTarget(null)
    } catch (e: any) {
      setError(e.message)
      setCombatModal(null)
      setAttackPhase(null)
      setAnimPhase('idle')
      setAttackTarget(null)
      setFloatingDmg(null)
    }
  }

  const dismissCombat = () => {
    setCombatModal(null)
    setAttackPhase(null)
  }

  const handleSelect = (ns: string, name: string) => {
    navigate(`/dungeon/${ns}/${name}`)
  }

  const handleDelete = async (ns?: string, name?: string) => {
    const delNs = ns || selected?.ns
    const delName = name || selected?.name
    if (!delNs || !delName) return
    if (!confirm(`Delete dungeon "${delName}"? This cannot be undone.`)) return
    setDeleting(delName)
    try {
      await deleteDungeon(delNs, delName)
      if (selected?.name === delName) navigate('/')
      // Poll until dungeon is actually gone
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const list = await listDungeons()
        setDungeons(list)
        if (!list.find(d => d.name === delName)) { setDeleting(null); return }
      }
      setDeleting(null)
    } catch (e: any) { setError(e.message); setDeleting(null) }
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
        <button onClick={() => setError('')} style={{ background: 'none', border: 'none', color: '#e94560', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px' }}>✕</button>
      </div>}

      {!selected ? (
        <>
          <div className="ns-filter">
            {['default', 'tests'].map(n => (
              <button key={n} className={`btn ${activeNs === n ? 'btn-gold' : 'btn-blue'}`}
                style={{ fontSize: '7px', padding: '4px 10px' }}
                onClick={() => setActiveNs(n)}>{n}</button>
            ))}
          </div>
          <CreateForm onCreate={handleCreate} />
          <DungeonList dungeons={dungeons.filter(d => d.namespace === activeNs)} onSelect={handleSelect} onDelete={handleDelete} deleting={deleting} />
        </>
      ) : loading ? (
        <div className="loading">Initializing dungeon</div>
      ) : detail ? (
        <DungeonView
          cr={detail}
          onBack={() => { navigate('/'); refresh() }}
          onAttack={handleAttack}
          attackPhase={attackPhase}
          animPhase={animPhase}
          attackTarget={attackTarget}
          floatingDmg={floatingDmg}
          combatModal={combatModal}
          onDismissCombat={dismissCombat}
          lootDrop={lootDrop}
          onDismissLoot={() => { setLootDrop(null); prevInventoryRef.current = detail?.spec.inventory || '' }}
          events={events}
          showLoot={showLoot}
          onOpenLoot={() => setShowLoot(true)}
          onCloseLoot={() => setShowLoot(false)}
          currentTurn={'hero'}
          turnRound={1}
          showHelp={showHelp}
          onToggleHelp={() => setShowHelp(h => !h)}
        />
      ) : null}
    </div>
  )
}

function CreateForm({ onCreate }: { onCreate: (n: string, m: number, d: string, c: string) => void }) {
  const [name, setName] = useState('')
  const [monsters, setMonsters] = useState(3)
  const [difficulty, setDifficulty] = useState('normal')
  const [heroClass, setHeroClass] = useState('warrior')
  return (
    <div className="create-form">
      <div><label>Dungeon Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="my-dungeon" /></div>
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
      <button className="btn btn-gold" onClick={() => { if (name) { onCreate(name, monsters, difficulty, heroClass); setName('') } }}>
        Create Dungeon
      </button>
    </div>
  )
}

function DungeonList({ dungeons, onSelect, onDelete, deleting }: {
  dungeons: DungeonSummary[]; onSelect: (ns: string, name: string) => void
  onDelete: (ns: string, name: string) => void; deleting: string | null
}) {
  if (!dungeons.length) return <div className="loading">No dungeons yet — create one above</div>
  return (
    <div className="dungeon-list">
      {dungeons.map(d => (
        <div key={d.name} className={`dungeon-tile${deleting === d.name ? ' deleting' : ''}`} onClick={() => onSelect(d.namespace, d.name)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>{d.victory ? '' : ''}{d.name}</h3>
            {deleting === d.name ? (
              <span style={{ fontSize: '7px', color: 'var(--accent)' }}>Deleting...</span>
            ) : (
              <button className="tile-delete-btn" onClick={e => { e.stopPropagation(); onDelete(d.namespace, d.name) }}>✕</button>
            )}
          </div>
          <div className="stats">
            <span className={`tag tag-${d.difficulty}`}>{d.difficulty}</span>
            <span>Monsters: {d.livingMonsters ?? '?'}</span>
            <span>Boss: {d.bossState === 'pending' ? 'Locked' : d.bossState === 'ready' ? 'Ready' : d.bossState === 'defeated' ? 'Defeated' : d.bossState ?? '?'}</span>
            {d.victory && <span className="victory">VICTORY!</span>}
            {!d.victory && <span style={{ color: 'var(--green)' }}>In Progress</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function DungeonView({ cr, onBack, onAttack, events, showLoot, onOpenLoot, onCloseLoot, currentTurn, turnRound, attackPhase, animPhase, attackTarget, showHelp, onToggleHelp, floatingDmg, combatModal, onDismissCombat, lootDrop, onDismissLoot }: {
  cr: DungeonCR; onBack: () => void; onAttack: (t: string, d: number) => void; events: WSEvent[]
  showLoot: boolean; onOpenLoot: () => void; onCloseLoot: () => void
  currentTurn: string; turnRound: number; attackPhase: string | null
  animPhase: string; attackTarget: string | null
  showHelp: boolean; onToggleHelp: () => void
  floatingDmg: { target: string; amount: string; color: string } | null
  combatModal: { phase: string; formula: string; heroAction: string; enemyAction: string; spec: any; oldHP: number } | null
  onDismissCombat: () => void
  lootDrop: string | null; onDismissLoot: () => void
}) {
  if (!cr?.metadata?.name) return <div className="loading">Loading dungeon</div>
  const spec = cr.spec || { monsters: 0, difficulty: 'normal', monsterHP: [], bossHP: 0, heroHP: 100, currentTurn: 'hero', turnRound: 1 }
  const status = cr.status
  const dungeonName = cr.metadata.name
  const maxMonsterHP = Number(status?.maxMonsterHP) || Math.max(...(spec.monsterHP || [1]))
  const maxBossHP = Number(status?.maxBossHP) || spec.bossHP
  const heroHP = spec.heroHP ?? 100
  const maxHeroHP = Number(status?.maxHeroHP) || heroHP
  const isDefeated = status?.defeated || heroHP <= 0
  const bossState = status?.bossState || 'pending'
  const isHeroTurn = !currentTurn || currentTurn === 'hero'
  const gameOver = isDefeated || status?.victory

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
        <h2><PixelIcon name="sword" size={14} /> {dungeonName}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="help-btn" onClick={onToggleHelp}>?</button>
          <button className="back-btn" onClick={onBack}>← Back</button>
        </div>
      </div>

      {showHelp && (
        <div className="modal-overlay" onClick={onToggleHelp}>
          <div className="modal help-modal" onClick={e => e.stopPropagation()}>
            <h2 style={{ color: 'var(--gold)', fontSize: 12, marginBottom: 12 }}>📖 HOW TO PLAY</h2>
            <div className="help-section">
              <h3><PixelIcon name="sword" size={10} /> Combat</h3>
              <p>Click a monster or boss to roll dice and attack. After your attack, all alive enemies counter-attack automatically.</p>
              <p>Kill all monsters to unlock the boss. Defeat the boss to win!</p>
            </div>
            <div className="help-section">
              <h3>⊞ Dice by Difficulty</h3>
              <table className="help-table">
                <thead><tr><th>Diff</th><th>Monster HP</th><th>Boss HP</th><th>Dice</th></tr></thead>
                <tbody>
                  <tr><td className="tag-easy">Easy</td><td>30</td><td>200</td><td>2d8+5</td></tr>
                  <tr><td className="tag-normal">Normal</td><td>50</td><td>400</td><td>2d10+8</td></tr>
                  <tr><td className="tag-hard">Hard</td><td>80</td><td>800</td><td>3d10+10</td></tr>
                </tbody>
              </table>
            </div>
            <div className="help-section">
              <h3><PixelIcon name="shield" size={10} /> Hero Classes</h3>
              <table className="help-table">
                <thead><tr><th>Class</th><th>HP</th><th>Special</th></tr></thead>
                <tbody>
                  <tr><td>⚔️ Warrior</td><td>150</td><td>20% damage reduction on counter-attacks</td></tr>
                  <tr><td>🔮 Mage</td><td>80</td><td>1.5x boss damage. 5 mana (1/attack, half dmg at 0)</td></tr>
                  <tr><td>🗡️ Rogue</td><td>100</td><td>1.2x damage. 30% dodge on counter-attacks</td></tr>
                </tbody>
              </table>
            </div>
            <div className="help-section">
              <h3>💡 Tips</h3>
              <p>• Kill monsters first to reduce counter-attack damage</p>
              <p>• Warrior: tank through with high HP</p>
              <p>• Mage: rush the boss with 1.5x damage before mana runs out</p>
              <p>• Rogue: pray for dodge procs</p>
            </div>
            <button className="btn btn-gold" style={{ marginTop: 12 }} onClick={onToggleHelp}>Got it!</button>
          </div>
        </div>
      )}

      {combatModal && (
        <div className="modal-overlay">
          <div className="modal combat-modal" onClick={e => e.stopPropagation()}>
            {combatModal.phase === 'rolling' ? (
              <>
                <h2 style={{ color: 'var(--gold)', fontSize: 14, marginBottom: 16 }}>COMBAT</h2>
                <DiceRoller formula={combatModal.formula} />
                <p style={{ fontSize: 8, color: '#888', marginTop: 12 }}>Waiting for attack to resolve...</p>
              </>
            ) : (
              <>
                <button className="modal-close" onClick={onDismissCombat}>✕</button>
                <h2 style={{ color: 'var(--gold)', fontSize: 14, marginBottom: 12 }}>COMBAT RESULTS</h2>
                <CombatBreakdown heroAction={combatModal.heroAction} enemyAction={combatModal.enemyAction} spec={combatModal.spec} oldHP={combatModal.oldHP} />
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
        </div>
      )}

      {status?.victory && (
        <div className="victory-banner">
          <h2><PixelIcon name="crown" size={18} /> VICTORY! <PixelIcon name="crown" size={18} /></h2>
          <p className="loot">The dungeon has been conquered!</p>
          {(spec.treasureOpened ?? 0) === 0 ? (
            <button className="btn btn-gold" style={{ marginTop: 12 }}
              disabled={!!attackPhase}
              onClick={() => onAttack('open-treasure', 0)}>
              <PixelIcon name="key" size={12} /> Open Treasure
            </button>
          ) : (
            <div className="loot-content" style={{ marginTop: 12 }}>{status?.loot || 'Loading treasure...'}</div>
          )}
        </div>
      )}

      {lootDrop && (
        <div className="modal-overlay" onClick={onDismissLoot}>
          <div className="modal" onClick={e => e.stopPropagation()}>
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
               lootDrop.includes('manapotion') ? 'Use to restore mana' : 'A mysterious item'}
            </div>
            <button className="btn btn-gold" onClick={onDismissLoot}>Got it!</button>
          </div>
        </div>
      )}

      <div className="status-bar">
        <div><span className="label">Monsters alive:</span><span className="value">{status?.livingMonsters ?? '?'}</span></div>
        <div><span className="label">Boss:</span><span className="value">{bossState}</span></div>
        <div><span className="label">Difficulty:</span><span className="value">{spec.difficulty}</span></div>
        {spec.modifier && spec.modifier !== 'none' && (
          <div title={status?.modifier || spec.modifier} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ItemSprite id={spec.modifier} size={20} />
            <span className="value">{status?.modifier || spec.modifier}</span>
          </div>
        )}
      </div>

      <Tooltip text={
        spec.heroClass === 'mage' ? '🔮 Mage · 80 HP · 1.5x boss damage · 5 mana (1/attack, half dmg at 0) · <PixelIcon name="heal" size={12} /> Heal: costs 2 mana, restores 30 HP' :
        spec.heroClass === 'rogue' ? '🗡️ Rogue · 100 HP · 1.2x damage · 30% dodge on counter-attacks · <PixelIcon name="dagger" size={12} /> Backstab: 3x damage, 3-turn cooldown' :
        '⚔️ Warrior · 150 HP · 20% damage reduction on counter-attacks · <PixelIcon name="shield" size={12} /> Taunt: activate before attacking for 60% counter-attack reduction (1 turn cooldown)'
      }>
      <div className="hero-bar" style={{ position: 'relative' }}>
        {floatingDmg?.target === 'hero' && <div className="floating-dmg" style={{ color: floatingDmg.color }}>{floatingDmg.amount}</div>}
        <Sprite spriteType={spec.heroClass || 'warrior'} size={64}
          action={isDefeated ? 'dead' : status?.victory ? 'victory' : animPhase === 'hero-attack' ? 'attack' : animPhase === 'enemy-attack' ? 'hurt' : 'idle'} />
        <span className="hero-label">{(spec.heroClass || 'warrior').toUpperCase()}</span>
        <div className="hp-bar-bg" style={{ flex: 1 }}>
          <div className={`hp-bar-fill ${heroHP > 60 ? 'high' : heroHP > 30 ? 'mid' : 'low'}`}
            style={{ width: `${Math.min((heroHP / maxHeroHP) * 100, 100)}%` }} />
        </div>
        <span className="hero-hp-text">HP: {heroHP} / {maxHeroHP}</span>
        {(spec.heroClass === 'mage') && <span className="mana-text">◇ Mana: {spec.heroMana ?? 0}</span>}
      </div>
      </Tooltip>

      {!gameOver && !attackPhase && (
        <div className="ability-bar">
          {spec.heroClass === 'mage' && (
            <button className="btn btn-ability" disabled={(spec.heroMana ?? 0) < 2 || heroHP >= 80}
              onClick={() => onAttack('hero', 0)}>
              <PixelIcon name="heal" size={12} /> Heal (2 mana)
            </button>
          )}
          {spec.heroClass === 'warrior' && (
            <button className={`btn btn-ability${(spec.tauntActive ?? 0) === 1 ? ' active' : ''}`}
              disabled={(spec.tauntActive ?? 0) >= 1}
              onClick={() => onAttack('activate-taunt', 0)}>
              <PixelIcon name="shield" size={12} /> Taunt {(spec.tauntActive ?? 0) > 1 ? `(${(spec.tauntActive ?? 0) - 1} CD)` : (spec.tauntActive ?? 0) === 1 ? '(Active!)' : ''}
            </button>
          )}
          {spec.heroClass === 'rogue' && (
            <span className="cooldown-text">
              <PixelIcon name="dagger" size={12} /> Backstab: {(spec.backstabCooldown ?? 0) > 0 ? `${spec.backstabCooldown} turns CD` : 'Ready!'}
            </span>
          )}
        </div>
      )}

      {(() => {
        const items = (spec.inventory || '').split(',').filter(Boolean)
        const wb = spec.weaponBonus || 0
        const wu = spec.weaponUses || 0
        const ab = spec.armorBonus || 0
        const modifier = spec.modifier || 'none'
        const poison = spec.poisonTurns || 0
        const burn = spec.burnTurns || 0
        const stun = spec.stunTurns || 0
        const RARITY_COLOR: Record<string, string> = { common: '#aaa', rare: '#5dade2', epic: '#9b59b6' }

        return (
          <div className="equip-panel">
            <div className="equip-grid">
              <div className="equip-row">
                <div className="equip-slot empty" title="Helmet (coming soon)"><PixelIcon name="lock" size={16} /></div>
              </div>
              <div className="equip-row">
                <div className="equip-slot empty" title="Shield (coming soon)"><PixelIcon name="lock" size={16} /></div>
                <div className={`equip-slot${ab > 0 ? ' filled' : ' empty'}`} title={ab > 0 ? `Armor: +${ab}% defense` : 'No armor'}>
                  {ab > 0 ? <><ItemSprite id="armor-common" size={24} /><span className="slot-stat">+{ab}%</span></> : <PixelIcon name="shield" size={16} color="#333" />}
                </div>
                <div className={`equip-slot${wb > 0 ? ' filled' : ' empty'}`} title={wb > 0 ? `Weapon: +${wb} dmg (${wu} uses)` : 'No weapon'}>
                  {wb > 0 ? <><ItemSprite id="weapon-common" size={24} /><span className="slot-stat">+{wb}</span></> : <PixelIcon name="sword" size={16} color="#333" />}
                </div>
              </div>
              <div className="equip-row">
                <div className="equip-slot empty" title="Pants (coming soon)"><PixelIcon name="lock" size={16} /></div>
              </div>
              <div className="equip-row">
                <div className="equip-slot empty" title="Boots (coming soon)"><PixelIcon name="lock" size={16} /></div>
              </div>
            </div>

            <div className="status-row">
              {modifier !== 'none' && (
                <div className={`status-badge ${modifier.startsWith('curse') ? 'curse' : 'blessing'}`} title={status?.modifier || modifier}>
                  <ItemSprite id={modifier} size={20} />
                </div>
              )}
              {poison > 0 && <div className="status-badge effect" title={`Poison: ${poison} turns`}><PixelIcon name="poison" size={14} /><span>{poison}</span></div>}
              {burn > 0 && <div className="status-badge effect" title={`Burn: ${burn} turns`}><PixelIcon name="fire" size={14} /><span>{burn}</span></div>}
              {stun > 0 && <div className="status-badge effect" title={`Stun: ${stun} turns`}><PixelIcon name="lightning" size={14} /><span>{stun}</span></div>}
            </div>

            {items.length > 0 && (
              <div className="backpack">
                <div className="backpack-label">Backpack</div>
                <div className="backpack-grid">
                  {items.map((item, i) => {
                    const rarity = item.split('-').pop()!
                    const isPotion = item.includes('potion')
                    return (
                      <button key={i} className="backpack-slot" disabled={gameOver || !!attackPhase}
                        style={{ borderColor: RARITY_COLOR[rarity] || '#555' }}
                        title={item.replace(/-/g, ' ')}
                        onClick={() => onAttack(isPotion ? `use-${item}` : `equip-${item}`, 0)}>
                        <ItemSprite id={item} size={24} />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      <h3 style={{ fontSize: '10px', marginBottom: 8, color: '#888' }}>MONSTERS</h3>
      <div className="monster-grid">
        {(spec.monsterHP || []).map((hp, idx) => {
          const state = hp > 0 ? 'alive' : 'dead'
          const mName = `${dungeonName}-monster-${idx}`
          const mSprite = getMonsterSprite(idx)
          let mAction: SpriteAction = state === 'dead' ? 'dead' : 'idle'
          if (attackTarget === mName && animPhase === 'hero-attack') mAction = 'hurt'
          if (state === 'alive' && animPhase === 'enemy-attack') mAction = 'attack'
          return (
            <EntityCard key={mName} name={mName} entity="monster"
              state={state} hp={hp} maxHP={maxMonsterHP} diceFormula={status?.diceFormula || "2d10+8"} onAttack={onAttack} disabled={gameOver || !!attackPhase}
              spriteType={mSprite} spriteAction={mAction}
              floatingDmg={floatingDmg?.target === mName ? floatingDmg.amount : null}
              heroClass={spec.heroClass} backstabCooldown={spec.backstabCooldown}
              tooltip={`${mSprite} · HP: ${hp}/${maxMonsterHP} · Counter: ${status?.monsterCounter || '?'} dmg/monster`} />
          )
        })}
      </div>

      <h3 style={{ fontSize: '10px', marginBottom: 8, color: '#888' }}>BOSS</h3>
      <div style={{ maxWidth: 200 }}>
      {(() => {
        let bAction: SpriteAction = bossState === 'defeated' ? 'dead' : bossState === 'pending' ? 'idle' : 'idle'
        if (attackTarget?.includes('boss') && animPhase === 'hero-attack') bAction = 'hurt'
        if (bossState === 'ready' && animPhase === 'enemy-attack' && attackTarget?.includes('boss')) bAction = 'attack'
        if (status?.victory) bAction = 'dead'
        return <EntityCard name={`${dungeonName}-boss`} entity="boss"
          state={bossState} hp={spec.bossHP} maxHP={maxBossHP} diceFormula={status?.diceFormula || "2d10+8"} onAttack={onAttack} disabled={gameOver || !!attackPhase}
          spriteType="dragon" spriteAction={bAction}
          floatingDmg={floatingDmg?.target?.includes('boss') ? floatingDmg.amount : null}
          heroClass={spec.heroClass} backstabCooldown={spec.backstabCooldown}
          tooltip={`Dragon · HP: ${spec.bossHP}/${maxBossHP} · ${bossState === 'pending' ? 'Kill all monsters to unlock' : bossState === 'ready' ? 'Ready to fight!' : 'Defeated'} · Counter: ${status?.bossCounter || '?'} dmg`} />
      })()}
      </div>

      <h3 style={{ fontSize: '10px', margin: '16px 0 8px', color: '#888' }}>EVENT LOG</h3>
      <div className="event-log">
        {events.length === 0 && <div className="event-entry">Waiting for events...</div>}
        {events.map((e, i) => (
          <div key={i} className="event-entry">
            <span className="event-icon">{e.action}</span>
            <span className="event-msg">{e.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Parse dice formula from CR status (e.g. "2d8+5" -> {count:2, sides:8, mod:5})
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
  if (heroAction.includes('Mage critical')) lines.push({ icon: 'mana', text: 'Mage: 1.5x boss damage' })
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

function diceLabel(d: { count: number; sides: number; mod: number }) {
  return `${d.count}d${d.sides}+${d.mod}`
}

function EntityCard({ name, entity, state, hp, maxHP, diceFormula, onAttack, disabled, spriteType, spriteAction, tooltip, floatingDmg, heroClass, backstabCooldown }: {
  name: string; entity: string; state: string; hp: number; maxHP: number
  diceFormula: string; onAttack: (target: string, damage: number) => void; disabled?: boolean
  spriteType: string; spriteAction: SpriteAction; tooltip?: string; floatingDmg?: string | null
  heroClass?: string; backstabCooldown?: number
}) {
  const pct = maxHP > 0 ? Math.min((hp / maxHP) * 100, 100) : 0
  const hpClass = pct > 60 ? 'high' : pct > 30 ? 'mid' : 'low'
  const canAttack = !disabled && ((entity === 'monster' && state === 'alive') || (entity === 'boss' && state === 'ready'))
  const base = parseDice(diceFormula)
  const d = entity === 'boss' ? { count: base.count + 1, sides: base.sides + 2, mod: base.mod + 2 } : base

  return (
    <Tooltip text={tooltip || ''}>
    <div className={`entity-card ${state}`} style={{ position: 'relative' }}>
      {floatingDmg && <div className="floating-dmg" style={{ color: '#e94560' }}>{floatingDmg}</div>}
      <Sprite spriteType={spriteType} action={spriteAction} size={64} flip={entity !== 'boss' && entity !== 'monster' ? false : true} />
      <div className="entity-name">{name.split('-').slice(-2).join('-')}</div>
      <div className={`entity-state ${state}`}>{state}</div>
      <div className="hp-bar-container">
        <div className="hp-bar-bg"><div className={`hp-bar-fill ${hpClass}`} style={{ width: `${pct}%` }} /></div>
        <div className="hp-text">HP: {hp} / {maxHP}</div>
      </div>
      {canAttack && (
        <div className="attack-controls">
          <button className="btn btn-primary" style={{ fontSize: '7px', padding: '4px 8px' }}
            onClick={() => onAttack(name, 0)}>🎲 {diceLabel(d)}</button>
          {heroClass === 'rogue' && (backstabCooldown ?? 0) === 0 && (
            <button className="btn btn-ability" style={{ fontSize: '7px', padding: '4px 8px' }}
              onClick={() => onAttack(name + '-backstab', 0)}>Backstab</button>
          )}
        </div>
      )}
    </div>
    </Tooltip>
  )
}
