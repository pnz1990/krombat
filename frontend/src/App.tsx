import { useState, useCallback } from 'react'
import { DungeonSummary, DungeonDetail, listDungeons, getDungeon, createDungeon, submitAttack } from './api'
import { useWebSocket, WSEvent } from './useWebSocket'

const SPRITES: Record<string, string> = {
  monster_alive: '👹', monster_dead: '💀',
  boss_pending: '🔒', boss_ready: '🐉', boss_defeated: '👑',
  treasure: '🏆',
}

export default function App() {
  const [dungeons, setDungeons] = useState<DungeonSummary[]>([])
  const [selected, setSelected] = useState<{ ns: string; name: string } | null>(null)
  const [detail, setDetail] = useState<DungeonDetail | null>(null)
  const [events, setEvents] = useState<WSEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setDungeons(await listDungeons())
      if (selected) setDetail(await getDungeon(selected.ns, selected.name))
    } catch {}
  }, [selected])

  const connected = useWebSocket(useCallback((e: WSEvent) => {
    setEvents(prev => [e, ...prev].slice(0, 50))
    refresh()
  }, [refresh]))

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

  const handleSelect = async (ns: string, name: string) => {
    setSelected({ ns, name })
    setLoading(true)
    try {
      setDetail(await getDungeon(ns, name))
      setDungeons(await listDungeons())
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }

  // Initial load
  useState(() => { listDungeons().then(setDungeons).catch(() => {}) })

  return (
    <div className="app">
      <header className="header">
        <h1>⚔️ KUBERNETES RPG ⚔️</h1>
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
          detail={detail}
          onBack={() => { setSelected(null); setDetail(null); refresh() }}
          onAttack={handleAttack}
          events={events}
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

function DungeonView({ detail, onBack, onAttack, events }: {
  detail: DungeonDetail; onBack: () => void; onAttack: (t: string, d: number) => void; events: WSEvent[]
}) {
  const { dungeon, pods } = detail
  const spec = dungeon.spec || {}
  const status = dungeon.status || {}
  const podList = pods?.items || []
  const monsters = podList.filter(p => p.metadata.labels['game.k8s.example/entity'] === 'monster')
  const boss = podList.find(p => p.metadata.labels['game.k8s.example/entity'] === 'boss')
  const maxMonsterHP = { easy: 30, normal: 50, hard: 80 }[spec.difficulty as string] || 50
  const maxBossHP = { easy: 200, normal: 400, hard: 800 }[spec.difficulty as string] || 400

  return (
    <div>
      <div className="dungeon-header">
        <h2>⚔️ {dungeon.metadata.name}</h2>
        <button className="back-btn" onClick={onBack}>← Back to dungeons</button>
      </div>

      {status.victory && (
        <div className="victory-banner">
          <h2>🏆 VICTORY! 🏆</h2>
          <p className="loot">The dungeon has been conquered!</p>
        </div>
      )}

      <div className="status-bar">
        <div><span className="label">Monsters alive:</span><span className="value">{status.livingMonsters ?? '?'}</span></div>
        <div><span className="label">Boss:</span><span className="value">{status.bossState ?? '?'}</span></div>
        <div><span className="label">Difficulty:</span><span className="value">{spec.difficulty}</span></div>
      </div>

      <h3 style={{ fontSize: '10px', marginBottom: 8, color: '#888' }}>MONSTERS</h3>
      <div className="monster-grid">
        {monsters.map(m => {
          const state = m.metadata.labels['game.k8s.example/state']
          const hp = parseInt(m.metadata.annotations['game.k8s.example/hp'] || '0')
          return (
            <EntityCard key={m.metadata.name} name={m.metadata.name} entity="monster"
              state={state} hp={hp} maxHP={maxMonsterHP} onAttack={onAttack} />
          )
        })}
      </div>

      {boss && (
        <>
          <h3 style={{ fontSize: '10px', marginBottom: 8, color: '#888' }}>BOSS</h3>
          <EntityCard name={boss.metadata.name} entity="boss"
            state={boss.metadata.labels['game.k8s.example/state']}
            hp={parseInt(boss.metadata.annotations['game.k8s.example/hp'] || '0')}
            maxHP={maxBossHP} onAttack={onAttack} />
        </>
      )}

      <h3 style={{ fontSize: '10px', margin: '16px 0 8px', color: '#888' }}>EVENT LOG</h3>
      <div className="event-log">
        {events.length === 0 && <div className="event-entry">Waiting for events...</div>}
        {events.map((e, i) => (
          <div key={i} className="event-entry">
            <span className="event-type">[{e.type}]</span> {e.action} {e.name}
          </div>
        ))}
      </div>
    </div>
  )
}

function EntityCard({ name, entity, state, hp, maxHP, onAttack }: {
  name: string; entity: string; state: string; hp: number; maxHP: number
  onAttack: (target: string, damage: number) => void
}) {
  const [dmg, setDmg] = useState(entity === 'boss' ? 100 : 25)
  const pct = maxHP > 0 ? (hp / maxHP) * 100 : 0
  const hpClass = pct > 60 ? 'high' : pct > 30 ? 'mid' : 'low'
  const sprite = entity === 'boss'
    ? SPRITES[`boss_${state}`] || '🐉'
    : SPRITES[`monster_${state}`] || '👹'
  const canAttack = (entity === 'monster' && state === 'alive') || (entity === 'boss' && state === 'ready')

  return (
    <div className={`entity-card ${state}`}>
      <div className="entity-sprite">{sprite}</div>
      <div className="entity-name">{name.split('-').slice(-2).join('-')}</div>
      <div className={`entity-state ${state}`}>{state}</div>
      <div className="hp-bar-container">
        <div className="hp-bar-bg"><div className={`hp-bar-fill ${hpClass}`} style={{ width: `${pct}%` }} /></div>
        <div className="hp-text">HP: {hp} / {maxHP}</div>
      </div>
      {canAttack && (
        <div className="attack-controls">
          <input type="number" min={1} value={dmg} onChange={e => setDmg(+e.target.value)} />
          <button className="btn btn-primary" style={{ fontSize: '7px', padding: '4px 8px' }}
            onClick={() => onAttack(name, dmg)}>⚔️ ATK</button>
        </div>
      )}
    </div>
  )
}
