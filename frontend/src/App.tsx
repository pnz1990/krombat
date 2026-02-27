import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { DungeonSummary, DungeonCR, listDungeons, getDungeon, createDungeon, submitAttack } from './api'
import { useWebSocket, WSEvent } from './useWebSocket'

const SPRITES: Record<string, string> = {
  monster_alive: '👹', monster_dead: '💀',
  boss_pending: '🔒', boss_ready: '🐉', boss_defeated: '👑',
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

  // Refresh on WebSocket events
  useEffect(() => { if (lastEvent) {
    setEvents(prev => [lastEvent, ...prev].slice(0, 50))
    refresh()
  }}, [lastEvent, refresh])

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

  const handleCreate = async (name: string, monsters: number, difficulty: string) => {
    setError('')
    try {
      await createDungeon(name, monsters, difficulty)
      setTimeout(refresh, 2000)
    } catch (e: any) { setError(e.message) }
  }

  const handleAttack = async (target: string, damage: number) => {
    if (!selected) return
    setError('')
    try {
      await submitAttack(selected.ns, selected.name, target, damage)
      setTimeout(refresh, 3000)
    } catch (e: any) { setError(e.message) }
  }

  const handleSelect = (ns: string, name: string) => {
    navigate(`/dungeon/${ns}/${name}`)
  }

  return (
    <div className="app">
      <header className="header">
        <img src="/logo.png" alt="Kubernetes RPG" className="logo" />
        <p>Powered by kro ResourceGraphDefinitions on EKS</p>
        <p style={{ fontSize: '7px', marginTop: 4, color: connected ? '#00ff41' : '#e94560' }}>
          {connected ? '● CONNECTED' : '○ DISCONNECTED'}
        </p>
      </header>

      {error && <div className="card" style={{ borderColor: '#e94560', color: '#e94560', fontSize: '8px' }}>{error}</div>}

      {!selected ? (
        <>
          <CreateForm onCreate={handleCreate} />
          <DungeonList dungeons={dungeons} onSelect={handleSelect} />
        </>
      ) : loading ? (
        <div className="loading">Loading dungeon</div>
      ) : detail ? (
        <DungeonView
          cr={detail}
          onBack={() => { navigate('/'); refresh() }}
          onAttack={handleAttack}
          events={events}
          showLoot={showLoot}
          onOpenLoot={() => setShowLoot(true)}
          onCloseLoot={() => setShowLoot(false)}
        />
      ) : null}
    </div>
  )
}

function CreateForm({ onCreate }: { onCreate: (n: string, m: number, d: string) => void }) {
  const [name, setName] = useState('')
  const [monsters, setMonsters] = useState(3)
  const [difficulty, setDifficulty] = useState('normal')
  return (
    <div className="create-form">
      <div><label>Dungeon Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="my-dungeon" /></div>
      <div><label>Monsters</label><input type="number" min={1} max={10} value={monsters} onChange={e => setMonsters(+e.target.value)} /></div>
      <div><label>Difficulty</label>
        <select value={difficulty} onChange={e => setDifficulty(e.target.value)}>
          <option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option>
        </select>
      </div>
      <button className="btn btn-gold" onClick={() => { if (name) { onCreate(name, monsters, difficulty); setName('') } }}>
        Create Dungeon
      </button>
    </div>
  )
}

function DungeonList({ dungeons, onSelect }: { dungeons: DungeonSummary[]; onSelect: (ns: string, name: string) => void }) {
  if (!dungeons.length) return <div className="loading">No dungeons yet — create one above</div>
  return (
    <div className="dungeon-list">
      {dungeons.map(d => (
        <div key={d.name} className="dungeon-tile" onClick={() => onSelect(d.namespace, d.name)}>
          <h3>{d.victory ? '👑 ' : '⚔️ '}{d.name}</h3>
          <div className="stats">
            <span className={`tag tag-${d.difficulty}`}>{d.difficulty}</span>
            <span>Monsters: {d.livingMonsters ?? '?'}</span>
            <span>Boss: {d.bossState ?? '?'}</span>
            {d.victory && <span className="victory">VICTORY!</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function DungeonView({ cr, onBack, onAttack, events, showLoot, onOpenLoot, onCloseLoot }: {
  cr: DungeonCR; onBack: () => void; onAttack: (t: string, d: number) => void; events: WSEvent[]
  showLoot: boolean; onOpenLoot: () => void; onCloseLoot: () => void
}) {
  if (!cr?.metadata?.name) return <div className="loading">Loading dungeon</div>
  const spec = cr.spec || { monsters: 0, difficulty: 'normal', monsterHP: [], bossHP: 0 }
  const status = cr.status
  const dungeonName = cr.metadata.name
  const maxMonsterHP = { easy: 30, normal: 50, hard: 80 }[spec.difficulty] || 50
  const maxBossHP = { easy: 200, normal: 400, hard: 800 }[spec.difficulty] || 400
  const heroHP = (spec as any).heroHP ?? 100
  const maxHeroHP = 100
  const isDefeated = heroHP <= 0
  const bossState = status?.bossState || (spec.bossHP > 0 ? ((spec.monsterHP || []).every(hp => hp === 0) ? 'ready' : 'pending') : 'defeated')

  return (
    <div>
      <div className="dungeon-header">
        <h2>⚔️ {dungeonName}</h2>
        <button className="back-btn" onClick={onBack}>← Back to dungeons</button>
      </div>

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

      <div className="status-bar">
        <div><span className="label">Monsters alive:</span><span className="value">{status?.livingMonsters ?? '?'}</span></div>
        <div><span className="label">Boss:</span><span className="value">{bossState}</span></div>
        <div><span className="label">Difficulty:</span><span className="value">{spec.difficulty}</span></div>
      </div>

      <div className="hero-bar">
        <span className="hero-label">🛡️ HERO</span>
        <div className="hp-bar-bg" style={{ flex: 1 }}>
          <div className={`hp-bar-fill ${heroHP > 60 ? 'high' : heroHP > 30 ? 'mid' : 'low'}`}
            style={{ width: `${(heroHP / maxHeroHP) * 100}%` }} />
        </div>
        <span className="hero-hp-text">HP: {heroHP} / {maxHeroHP}</span>
      </div>

      <h3 style={{ fontSize: '10px', marginBottom: 8, color: '#888' }}>MONSTERS</h3>
      <div className="monster-grid">
        {(spec.monsterHP || []).map((hp, idx) => {
          const state = hp > 0 ? 'alive' : 'dead'
          const mName = `${dungeonName}-monster-${idx}`
          return (
            <EntityCard key={mName} name={mName} entity="monster"
              state={state} hp={hp} maxHP={maxMonsterHP} difficulty={spec.difficulty} onAttack={onAttack} disabled={isDefeated} />
          )
        })}
      </div>

      <h3 style={{ fontSize: '10px', marginBottom: 8, color: '#888' }}>BOSS</h3>
      <EntityCard name={`${dungeonName}-boss`} entity="boss"
        state={bossState} hp={spec.bossHP} maxHP={maxBossHP} difficulty={spec.difficulty} onAttack={onAttack} disabled={isDefeated} />

      <h3 style={{ fontSize: '10px', margin: '16px 0 8px', color: '#888' }}>EVENT LOG</h3>
      <div className="event-log">
        {events.length === 0 && <div className="event-entry">Waiting for events...</div>}
        {events.map((e, i) => (
          <div key={i} className="event-entry">
            <span className="event-icon">{formatEventIcon(e)}</span>
            <span className="event-msg">{formatEventMsg(e)}</span>
            <span className="event-detail">{e.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatEventIcon(e: WSEvent): string {
  if (e.type === 'ATTACK_EVENT') return '⚔️'
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
  if (e.type === 'ATTACK_EVENT' && e.action === 'ADDED') return 'Attack submitted'
  if (e.type === 'ATTACK_EVENT' && e.action === 'MODIFIED') return 'Attack processing'
  if (e.type === 'ATTACK_EVENT' && e.action === 'DELETED') return 'Attack completed'
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
  easy: { count: 1, sides: 6, mod: 2 },
  normal: { count: 2, sides: 6, mod: 3 },
  hard: { count: 3, sides: 8, mod: 5 },
}

function rollDice(count: number, sides: number): number[] {
  return Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1)
}

function diceLabel(d: { count: number; sides: number; mod: number }) {
  return `${d.count}d${d.sides}+${d.mod}`
}

function EntityCard({ name, entity, state, hp, maxHP, difficulty, onAttack, disabled }: {
  name: string; entity: string; state: string; hp: number; maxHP: number
  difficulty: string; onAttack: (target: string, damage: number) => void; disabled?: boolean
}) {
  const [rolling, setRolling] = useState(false)
  const [displayDice, setDisplayDice] = useState<number[]>([])
  const [rolls, setRolls] = useState<number[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const pct = maxHP > 0 ? (hp / maxHP) * 100 : 0
  const hpClass = pct > 60 ? 'high' : pct > 30 ? 'mid' : 'low'
  const sprite = entity === 'boss'
    ? SPRITES[`boss_${state}`] || '🐉'
    : SPRITES[`monster_${state}`] || '👹'
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
    <div className={`entity-card ${state}`}>
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
      <div className="entity-sprite">{sprite}</div>
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
        </div>
      )}
    </div>
  )
}
