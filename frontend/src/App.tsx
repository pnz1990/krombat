import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { DungeonSummary, DungeonCR, listDungeons, getDungeon, createDungeon, submitAttack, deleteDungeon } from './api'
import { useWebSocket, WSEvent } from './useWebSocket'

import { Sprite, getMonsterSprite, SpriteAction, ItemSprite } from './Sprite'

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
      if (sel) setDetail(await getDungeon(sel.ns, sel.name))
    } catch {}
  }, [])

  // Refresh on WebSocket events — only refresh data, don't add to event log
  useEffect(() => { if (lastEvent) { refresh() } }, [lastEvent, refresh])

  // Initial load + load dungeon detail when URL changes
  useEffect(() => {
    if (selected) {
      setLoading(true)
      setEvents([])
      getDungeon(selected.ns, selected.name)
        .then(d => setDetail(d))
        .catch(e => setError(e.message))
        .finally(() => setLoading(false))
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
      setTimeout(refresh, 2000)
    } catch (e: any) { setError(e.message) }
  }

  const addEvent = (icon: string, msg: string) => {
    setEvents(prev => [{ type: 'COMBAT', action: icon, name: msg, namespace: '', payload: null }, ...prev].slice(0, 30))
  }

  const [floatingDmg, setFloatingDmg] = useState<{ target: string; amount: string; color: string } | null>(null)

  const handleAttack = async (target: string, damage: number) => {
    if (!selected || attackPhase) return
    setError('')
    const isAbility = target === 'hero' || target === 'activate-taunt'
    const shortTarget = isAbility ? target : target.replace(/-backstab$/, '').split('-').slice(-2).join('-')
    try {
      setAttackTarget(target.replace(/-backstab$/, ''))
      setAnimPhase('hero-attack')
      setAttackPhase(isAbility ? (target === 'hero' ? '💚 Healing...' : '🛡️ Taunting...') : `⚔️ Attacking ${shortTarget}...`)
      if (!isAbility) setFloatingDmg({ target: target.replace(/-backstab$/, ''), amount: `-${damage}`, color: '#e94560' })
      await submitAttack(selected.ns, selected.name, target, damage)
      await new Promise(r => setTimeout(r, 1500))
      setFloatingDmg(null)

      if (!isAbility) {
        setAnimPhase('enemy-attack')
        setAttackPhase('💀 Enemies counter-attack!')
        await new Promise(r => setTimeout(r, 1500))
      }

      // Phase 3: Resolve — poll until state reflects the attack
      setAttackPhase('⏳ Resolving...')
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
      // Detect new loot drops
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

      // Show counter-attack damage on hero
      const oldHP = detail?.spec.heroHP ?? 100
      const newHP = updated.spec.heroHP ?? 100
      const hpLost = oldHP - newHP
      if (hpLost > 0) {
        setFloatingDmg({ target: 'hero', amount: `-${hpLost}`, color: '#e94560' })
        setTimeout(() => setFloatingDmg(null), 1000)
      }

      // Read combat log from Dungeon CR
      const heroAction = updated.spec.lastHeroAction
      const enemyAction = updated.spec.lastEnemyAction
      if (heroAction) addEvent('⚔️', heroAction)
      if (enemyAction) addEvent('💀', enemyAction)
      const s = updated.status
      if (s?.victory) addEvent('🏆', 'VICTORY! Boss defeated!')
      else if (s?.bossState === 'ready') addEvent('🐉', 'Boss unlocked! All monsters slain!')
      else if ((updated.spec.heroHP ?? 100) <= 0) addEvent('💀', 'Hero has fallen...')

      setAttackPhase(null)
      setAnimPhase('idle')
      setAttackTarget(null)
    } catch (e: any) {
      setError(e.message)
      setAttackPhase(null)
      setAnimPhase('idle')
      setAttackTarget(null)
      setFloatingDmg(null)
    }
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
        <div className="loading">Loading dungeon</div>
      ) : detail ? (
        <DungeonView
          cr={detail}
          onBack={() => { navigate('/'); refresh() }}
          onAttack={handleAttack}
          onDelete={handleDelete}
          attackPhase={attackPhase}
          animPhase={animPhase}
          attackTarget={attackTarget}
          floatingDmg={floatingDmg}
          lootDrop={lootDrop}
          onDismissLoot={() => setLootDrop(null)}
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
            <h3>{d.victory ? '👑 ' : '⚔️ '}{d.name}</h3>
            {deleting === d.name ? (
              <span style={{ fontSize: '7px', color: 'var(--accent)' }}>Deleting...</span>
            ) : (
              <button className="tile-delete-btn" onClick={e => { e.stopPropagation(); onDelete(d.namespace, d.name) }}>🗑️</button>
            )}
          </div>
          <div className="stats">
            <span className={`tag tag-${d.difficulty}`}>{d.difficulty}</span>
            <span>Monsters: {d.livingMonsters ?? '?'}</span>
            <span>Boss: {d.bossState === 'pending' ? '🔒 Locked' : d.bossState === 'ready' ? '⚔️ Ready' : d.bossState === 'defeated' ? '👑 Defeated' : d.bossState ?? '?'}</span>
            {d.victory && <span className="victory">VICTORY!</span>}
            {!d.victory && <span style={{ color: 'var(--green)' }}>In Progress</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function DungeonView({ cr, onBack, onAttack, onDelete, events, showLoot, onOpenLoot, onCloseLoot, currentTurn, turnRound, attackPhase, animPhase, attackTarget, showHelp, onToggleHelp, floatingDmg, lootDrop, onDismissLoot }: {
  cr: DungeonCR; onBack: () => void; onAttack: (t: string, d: number) => void; onDelete: () => void; events: WSEvent[]
  showLoot: boolean; onOpenLoot: () => void; onCloseLoot: () => void
  currentTurn: string; turnRound: number; attackPhase: string | null
  animPhase: string; attackTarget: string | null
  showHelp: boolean; onToggleHelp: () => void
  floatingDmg: { target: string; amount: string; color: string } | null
  lootDrop: string | null; onDismissLoot: () => void
}) {
  if (!cr?.metadata?.name) return <div className="loading">Loading dungeon</div>
  const spec = cr.spec || { monsters: 0, difficulty: 'normal', monsterHP: [], bossHP: 0, heroHP: 100, currentTurn: 'hero', turnRound: 1 }
  const status = cr.status
  const dungeonName = cr.metadata.name
  const maxMonsterHP = ({ easy: 30, normal: 50, hard: 80 } as Record<string,number>)[spec.difficulty] || 50
  const maxBossHP = ({ easy: 200, normal: 400, hard: 800 } as Record<string,number>)[spec.difficulty] || 400
  const heroHP = spec.heroHP ?? 100
  const maxHeroHP = { warrior: 150, mage: 80, rogue: 100 }[spec.heroClass || 'warrior'] || 100
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
        <h2>⚔️ {dungeonName}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="help-btn" onClick={onToggleHelp}>?</button>
          <button className="help-btn" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }} onClick={onDelete}>🗑️</button>
          <button className="back-btn" onClick={onBack}>← Back</button>
        </div>
      </div>

      {showHelp && (
        <div className="modal-overlay" onClick={onToggleHelp}>
          <div className="modal help-modal" onClick={e => e.stopPropagation()}>
            <h2 style={{ color: 'var(--gold)', fontSize: 12, marginBottom: 12 }}>📖 HOW TO PLAY</h2>
            <div className="help-section">
              <h3>⚔️ Combat</h3>
              <p>Click a monster or boss to roll dice and attack. After your attack, all alive enemies counter-attack automatically.</p>
              <p>Kill all monsters to unlock the boss. Defeat the boss to win!</p>
            </div>
            <div className="help-section">
              <h3>🎲 Dice by Difficulty</h3>
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
              <h3>🛡️ Hero Classes</h3>
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

      {!gameOver && (
        <div className={`turn-bar ${attackPhase ? 'attacking' : ''}`}>
          <span className="turn-indicator">{attackPhase || '⚔️ Ready to attack!'}</span>
        </div>
      )}

      {isDefeated && (
        <div className="defeat-banner">
          <h2>💀 DEFEAT 💀</h2>
          <p className="defeat-text">Your hero has fallen...</p>
        </div>
      )}

      {status?.victory && (
        <div className="victory-banner">
          <h2>🏆 VICTORY! 🏆</h2>
          <p className="loot">The dungeon has been conquered!</p>
          <button className="btn btn-gold" style={{ marginTop: 12 }} onClick={onOpenLoot}>
            🗝️ Open Treasure
          </button>
        </div>
      )}

      {showLoot && (
        <div className="modal-overlay" onClick={onCloseLoot}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🏆</div>
            <h2 style={{ color: 'var(--gold)', fontSize: 14, marginBottom: 12 }}>TREASURE UNLOCKED</h2>
            <div className="loot-content">{status?.loot || 'The treasure awaits...'}</div>
            <button className="btn btn-gold" style={{ marginTop: 16 }} onClick={onCloseLoot}>Close</button>
          </div>
        </div>
      )}

      {lootDrop && (
        <div className="modal-overlay" onClick={onDismissLoot}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🎁</div>
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
        spec.heroClass === 'mage' ? '🔮 Mage · 80 HP · 1.5x boss damage · 5 mana (1/attack, half dmg at 0) · 💚 Heal: costs 2 mana, restores 30 HP' :
        spec.heroClass === 'rogue' ? '🗡️ Rogue · 100 HP · 1.2x damage · 30% dodge on counter-attacks · 🗡️ Backstab: 3x damage, 3-turn cooldown' :
        '⚔️ Warrior · 150 HP · 20% damage reduction on counter-attacks · 🛡️ Taunt: activate before attacking for 60% counter-attack reduction (1 turn cooldown)'
      }>
      <div className="hero-bar" style={{ position: 'relative' }}>
        {floatingDmg?.target === 'hero' && <div className="floating-dmg" style={{ color: floatingDmg.color }}>{floatingDmg.amount}</div>}
        <Sprite spriteType={spec.heroClass || 'warrior'} size={64}
          action={isDefeated ? 'dead' : status?.victory ? 'victory' : animPhase === 'hero-attack' ? 'attack' : animPhase === 'enemy-attack' ? 'hurt' : 'idle'} />
        <span className="hero-label">{(spec.heroClass || 'warrior').toUpperCase()}</span>
        <div className="hp-bar-bg" style={{ flex: 1 }}>
          <div className={`hp-bar-fill ${heroHP > 60 ? 'high' : heroHP > 30 ? 'mid' : 'low'}`}
            style={{ width: `${(heroHP / maxHeroHP) * 100}%` }} />
        </div>
        <span className="hero-hp-text">HP: {heroHP} / {maxHeroHP}</span>
        {(spec.heroClass === 'mage') && <span className="mana-text">🔮 Mana: {spec.heroMana ?? 0}</span>}
      </div>
      </Tooltip>

      {((spec.poisonTurns ?? 0) > 0 || (spec.burnTurns ?? 0) > 0 || (spec.stunTurns ?? 0) > 0) && (
        <div className="effect-badges">
          {(spec.poisonTurns ?? 0) > 0 && <Tooltip text="Poison: -5 HP per turn. Applied by monsters on counter-attack."><span className="effect-badge poison">🟢 Poison ({spec.poisonTurns})</span></Tooltip>}
          {(spec.burnTurns ?? 0) > 0 && <Tooltip text="Burn: -8 HP per turn. Applied by boss on counter-attack."><span className="effect-badge burn">🔴 Burn ({spec.burnTurns})</span></Tooltip>}
          {(spec.stunTurns ?? 0) > 0 && <Tooltip text="Stun: your next attack is skipped."><span className="effect-badge stun">🟡 Stun ({spec.stunTurns})</span></Tooltip>}
        </div>
      )}

      {!gameOver && !attackPhase && (
        <div className="ability-bar">
          {spec.heroClass === 'mage' && (
            <button className="btn btn-ability" disabled={(spec.heroMana ?? 0) < 2 || heroHP >= 80}
              onClick={() => onAttack('hero', 0)}>
              💚 Heal (2 mana)
            </button>
          )}
          {spec.heroClass === 'warrior' && (
            <button className={`btn btn-ability${(spec.tauntActive ?? 0) === 1 ? ' active' : ''}`}
              disabled={(spec.tauntActive ?? 0) >= 1}
              onClick={() => onAttack('activate-taunt', 0)}>
              🛡️ Taunt {(spec.tauntActive ?? 0) > 1 ? `(${(spec.tauntActive ?? 0) - 1} CD)` : (spec.tauntActive ?? 0) === 1 ? '(Active!)' : ''}
            </button>
          )}
          {spec.heroClass === 'rogue' && (
            <span className="cooldown-text">
              🗡️ Backstab: {(spec.backstabCooldown ?? 0) > 0 ? `${spec.backstabCooldown} turns CD` : 'Ready!'}
            </span>
          )}
        </div>
      )}

      {(() => {
        const items = (spec.inventory || '').split(',').filter(Boolean)
        const wb = spec.weaponBonus || 0
        const wu = spec.weaponUses || 0
        const ab = spec.armorBonus || 0
        if (items.length === 0 && wb === 0 && ab === 0) return null
        const RARITY_COLOR: Record<string, string> = { common: '#aaa', rare: '#5dade2', epic: '#9b59b6' }
        return (
          <div className="inventory-bar">
            {wb > 0 && (
              <Tooltip text={`Weapon equipped: +${wb} damage, ${wu} uses remaining`}>
                <span className="equip-badge equipped"><ItemSprite id="weapon-common" size={16} /> ⚔️+{wb} ({wu})</span>
              </Tooltip>
            )}
            {ab > 0 && (
              <Tooltip text={`Armor equipped: +${ab}% damage reduction on counter-attacks`}>
                <span className="equip-badge equipped"><ItemSprite id="armor-common" size={16} /> 🛡️+{ab}%</span>
              </Tooltip>
            )}
            {items.map((item, i) => {
              const rarity = item.split('-').pop()!
              const isPotion = item.includes('potion')
              const isWeapon = item.includes('weapon')
              const isArmor = item.includes('armor')
              const alreadyEquipped = (isWeapon && wb > 0) || (isArmor && ab > 0)
              const label = isPotion ? 'Use' : alreadyEquipped ? 'Swap' : 'Equip'
              return (
                <Tooltip key={i} text={`${item.replace(/-/g, ' ')} — click to ${label.toLowerCase()}`}>
                  <button className="item-btn" disabled={!!attackPhase}
                    style={{ borderColor: RARITY_COLOR[rarity] || '#aaa' }}
                    onClick={() => onAttack(isPotion ? `use-${item}` : `equip-${item}`, 0)}>
                    <ItemSprite id={item} size={24} />
                    <span className="item-label">{label}</span>
                  </button>
                </Tooltip>
              )
            })}
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
              state={state} hp={hp} maxHP={maxMonsterHP} difficulty={spec.difficulty} onAttack={onAttack} disabled={isDefeated || !!attackPhase}
              spriteType={mSprite} spriteAction={mAction}
              floatingDmg={floatingDmg?.target === mName ? floatingDmg.amount : null}
              heroClass={spec.heroClass} backstabCooldown={spec.backstabCooldown}
              tooltip={`${mSprite} · HP: ${hp}/${maxMonsterHP} · Counter: ${({easy:5,normal:8,hard:12})[spec.difficulty] || 8} dmg/monster`} />
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
          state={bossState} hp={spec.bossHP} maxHP={maxBossHP} difficulty={spec.difficulty} onAttack={onAttack} disabled={isDefeated || !!attackPhase}
          spriteType="dragon" spriteAction={bAction}
          floatingDmg={floatingDmg?.target?.includes('boss') ? floatingDmg.amount : null}
          heroClass={spec.heroClass} backstabCooldown={spec.backstabCooldown}
          tooltip={`Dragon · HP: ${spec.bossHP}/${maxBossHP} · ${bossState === 'pending' ? 'Kill all monsters to unlock' : bossState === 'ready' ? 'Ready to fight!' : 'Defeated'} · Counter: ${({easy:15,normal:25,hard:40})[spec.difficulty] || 25} dmg`} />
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

function formatEventIcon(e: WSEvent): string {
  if (e.type === 'COMBAT' && e.action === 'HERO') return '⚔️'
  if (e.type === 'COMBAT' && e.action === 'MONSTER') return '💀'
  if (e.type === 'ATTACK_EVENT') return '📡'
  if (e.type === 'DUNGEON_UPDATE') {
    const s = e.payload?.status
    if (s?.victory) return '🏆'
    if (s?.bossState === 'ready') return '🐉'
    if (s?.bossState === 'defeated') return '👑'
    return '📜'
  }
  return '📡'
}

function formatEventMsg(e: WSEvent): string {
  if (e.type === 'COMBAT') return e.payload?.status?.bossState || 'Combat'
  if (e.type === 'ATTACK_EVENT' && e.action === 'ADDED') return 'Attack submitted'
  if (e.type === 'ATTACK_EVENT' && e.action === 'DELETED') return 'Attack completed'
  if (e.type === 'ATTACK_EVENT') return 'Attack processing'
  if (e.type === 'DUNGEON_UPDATE') {
    const s = e.payload?.status
    if (s?.victory) return 'VICTORY! Boss defeated!'
    if (s?.bossState === 'ready') return 'Boss unlocked! All monsters slain!'
    if (s?.bossState === 'defeated') return 'Boss has fallen!'
    const living = s?.livingMonsters
    if (living !== undefined) return `${living} monster${living !== 1 ? 's' : ''} remaining`
    return 'Dungeon state updated'
  }
  return `${e.action} ${e.type}`
}

const DICE: Record<string, { count: number; sides: number; mod: number }> = {
  easy: { count: 2, sides: 8, mod: 5 },
  normal: { count: 2, sides: 10, mod: 8 },
  hard: { count: 3, sides: 10, mod: 10 },
}

function rollDice(count: number, sides: number): number[] {
  return Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1)
}

function diceLabel(d: { count: number; sides: number; mod: number }) {
  return `${d.count}d${d.sides}+${d.mod}`
}

function EntityCard({ name, entity, state, hp, maxHP, difficulty, onAttack, disabled, spriteType, spriteAction, tooltip, floatingDmg, heroClass, backstabCooldown }: {
  name: string; entity: string; state: string; hp: number; maxHP: number
  difficulty: string; onAttack: (target: string, damage: number) => void; disabled?: boolean
  spriteType: string; spriteAction: SpriteAction; tooltip?: string; floatingDmg?: string | null
  heroClass?: string; backstabCooldown?: number
}) {
  const [rolling, setRolling] = useState(false)
  const [displayDice, setDisplayDice] = useState<number[]>([])
  const [rolls, setRolls] = useState<number[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const pct = maxHP > 0 ? (hp / maxHP) * 100 : 0
  const hpClass = pct > 60 ? 'high' : pct > 30 ? 'mid' : 'low'
  const canAttack = !disabled && !rolling && ((entity === 'monster' && state === 'alive') || (entity === 'boss' && state === 'ready'))
  const base = DICE[difficulty] || DICE.normal
  const d = entity === 'boss' ? { count: base.count + 1, sides: base.sides + 2, mod: base.mod + 2 } : base

  const handleRoll = () => {
    setRolling(true)
    setRolls([])
    setTotal(null)
    // Cycle random numbers during roll
    const interval = setInterval(() => {
      setDisplayDice(rollDice(d.count, d.sides))
    }, 80)
    setTimeout(() => {
      clearInterval(interval)
      const r = rollDice(d.count, d.sides)
      const dmg = r.reduce((a, b) => a + b, 0) + d.mod
      setRolls(r)
      setDisplayDice(r)
      setTotal(dmg)
      setTimeout(() => {
        onAttack(name, dmg)
        setRolls([])
        setTotal(null)
        setRolling(false)
      }, 800)
    }, 600)
  }

  return (
    <Tooltip text={tooltip || ''}>
    <div className={`entity-card ${state}`} style={{ position: 'relative' }}>
      {floatingDmg && <div className="floating-dmg" style={{ color: '#e94560' }}>{floatingDmg}</div>}
      {(rolling || total !== null) && (
        <div className="dice-roll-overlay">
          <div className="dice-formula">Rolling {diceLabel(d)}...</div>
          <div className="dice-container">
            {total === null
              ? displayDice.map((v, i) => (
                  <div key={i} className="die rolling">{v}</div>
                ))
              : rolls.map((v, i) => <div key={i} className="die landed">{v}</div>)
            }
          </div>
          {total !== null && (
            <>
              <div className="dice-modifier">{rolls.join(' + ')} + {d.mod}</div>
              <div className="dice-result">💥 {total}</div>
            </>
          )}
        </div>
      )}
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
            onClick={handleRoll}>🎲 {diceLabel(d)}</button>
          {heroClass === 'rogue' && (backstabCooldown ?? 0) === 0 && (
            <button className="btn btn-ability" style={{ fontSize: '7px', padding: '4px 8px' }}
              onClick={() => {
                const r = rollDice(d.count, d.sides)
                const dmg = r.reduce((a, b) => a + b, 0) + d.mod
                onAttack(name + '-backstab', dmg)
              }}>🗡️ Backstab</button>
          )}
        </div>
      )}
    </div>
    </Tooltip>
  )
}
