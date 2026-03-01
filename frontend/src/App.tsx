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
  const [k8sLog, setK8sLog] = useState<{ ts: string; cmd: string; res: string; yaml?: string }[]>([])
  const addK8s = (cmd: string, res: string, yaml?: string) => {
    const ts = new Date().toLocaleTimeString()
    setK8sLog(prev => [{ ts, cmd, res, yaml }, ...prev].slice(0, 50))
  }
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
      addK8s(`kubectl apply -f dungeon.yaml`, 'dungeon.game.k8s.example created',
        `apiVersion: game.k8s.example/v1alpha1\nkind: Dungeon\nmetadata:\n  name: ${name}\nspec:\n  monsters: ${monsters}\n  difficulty: ${difficulty}\n  heroClass: ${heroClass}`)
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
      const formula = detail?.status?.diceFormula || '2d12+4'

      if (!isAbility && !isItem) {
        setCombatModal({ phase: 'rolling', formula, heroAction: '', enemyAction: '', spec: detail?.spec, oldHP })
      }

      await submitAttack(selected.ns, selected.name, target, damage)
      addK8s(`kubectl apply -f attack.yaml`, 'attack.game.k8s.example created',
        `apiVersion: game.k8s.example/v1alpha1\nkind: Attack\nmetadata:\n  name: ${selected.name}-${target}-${Date.now() % 100000}\nspec:\n  dungeonName: ${selected.name}\n  dungeonNamespace: ${selected.ns}\n  target: ${target}\n  damage: ${damage}`)

      // Poll for CR update
      let updated = detail!
      for (let attempt = 0; attempt < 20; attempt++) {
        const fetched = await getDungeon(selected.ns, selected.name)
        if (fetched.spec.lastHeroAction !== detail?.spec.lastHeroAction) {
          updated = fetched
          addK8s(`kubectl get dungeon ${selected.name} -o json`, `heroHP:${fetched.spec.heroHP} bossHP:${fetched.spec.bossHP}`,
            JSON.stringify({ spec: fetched.spec, status: fetched.status }, null, 2))
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
          k8sLog={k8sLog}
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



function EventLogTabs({ events, k8sLog }: { events: WSEvent[]; k8sLog: { ts: string; cmd: string; res: string; yaml?: string }[] }) {
  const [tab, setTab] = useState<'game' | 'k8s'>('game')
  const [yamlModal, setYamlModal] = useState<string | null>(null)
  return (
    <div style={{ marginTop: 16 }}>
      <div className="log-tabs">
        <button className={`log-tab${tab === 'game' ? ' active' : ''}`} onClick={() => setTab('game')}>Game Log</button>
        <button className={`log-tab${tab === 'k8s' ? ' active' : ''}`} onClick={() => setTab('k8s')}>K8s Log</button>
      </div>
      {yamlModal && (
        <div className="modal-overlay" onClick={() => setYamlModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500, textAlign: 'left' }}>
            <pre className="yaml-view">{yamlModal}</pre>
            <button className="btn btn-gold" style={{ marginTop: 8 }} onClick={() => setYamlModal(null)}>Close</button>
          </div>
        </div>
      )}
      {tab === 'game' ? (
        <div className="event-log">
          {events.length === 0 && <div className="event-entry">Waiting for events...</div>}
          {events.map((e, i) => (
            <div key={i} className="event-entry">
              <span className="event-icon">{e.action}</span>
              <span className="event-msg">{e.name}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="event-log k8s-log">
          {k8sLog.length === 0 && <div className="event-entry">No K8s operations yet...</div>}
          {k8sLog.map((e, i) => (
            <div key={i} className={`k8s-entry${e.yaml ? ' clickable' : ''}`} onClick={() => e.yaml && setYamlModal(e.yaml)}>
              <span className="k8s-ts">{e.ts}</span>
              <span className="k8s-cmd">$ {e.cmd}</span>
              <span className="k8s-res">{e.res}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
function HelpModal({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(0)
  const pages = [
    { title: 'Combat Basics', content: (
      <>
        <p>Click a monster or boss to roll dice and attack. Damage is computed server-side based on difficulty.</p>
        <p>After your attack, all alive enemies counter-attack automatically. Kill all monsters to unlock the boss. Defeat the boss to win!</p>
        <table className="help-table">
          <thead><tr><th>Difficulty</th><th>Monster HP</th><th>Boss HP</th><th>Dice</th><th>Counter/Mon</th><th>Boss Counter</th></tr></thead>
          <tbody>
            <tr><td className="tag-easy">Easy</td><td>30</td><td>200</td><td>1d20+2</td><td>2</td><td>2</td></tr>
            <tr><td className="tag-normal">Normal</td><td>50</td><td>400</td><td>2d12+4</td><td>4</td><td>10</td></tr>
            <tr><td className="tag-hard">Hard</td><td>80</td><td>800</td><td>3d20+5</td><td>6</td><td>15</td></tr>
          </tbody>
        </table>
      </>
    )},
    { title: 'Hero Classes', content: (
      <>
        <table className="help-table">
          <thead><tr><th>Class</th><th>HP</th><th>Damage</th><th>Passive</th></tr></thead>
          <tbody>
            <tr><td><PixelIcon name="sword" size={10} /> Warrior</td><td>150</td><td>1.0x</td><td>20% damage reduction on all counter-attacks</td></tr>
            <tr><td><PixelIcon name="mana" size={10} /> Mage</td><td>80</td><td>1.5x boss</td><td>5 mana (1/attack). Half damage at 0 mana</td></tr>
            <tr><td><PixelIcon name="dagger" size={10} /> Rogue</td><td>100</td><td>1.2x</td><td>30% chance to dodge counter-attacks entirely</td></tr>
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
            <tr><td><PixelIcon name="heal" size={10} /> Mage</td><td>Heal</td><td>2 mana</td><td>Restore 30 HP (capped at 80). +1 mana regen when killing a monster.</td></tr>
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
            <tr><td><PixelIcon name="mana" size={10} /> Mana Potion</td><td>+2 mana</td><td>+3 mana</td><td>+5 mana</td></tr>
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
        <p><b>Mage:</b> Glass cannon. Rush the boss with 1.5x damage. Heal when low. Mana regens on monster kills.</p>
        <p><b>Rogue:</b> High risk/reward. Dodge procs can save you. Save Backstab (3x) for the boss.</p>
        <p><b>Items:</b> Equip weapons before attacking the boss. Use potions freely — they don't cost a turn.</p>
        <p><b>Modifiers:</b> Blessing of Fortune (20% crit) is the strongest. Curse of Fury makes boss fights brutal.</p>
      </>
    )},
  ]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={e => e.stopPropagation()}>
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
function DungeonView({ cr, onBack, onAttack, events, k8sLog, showLoot, onOpenLoot, onCloseLoot, currentTurn, turnRound, attackPhase, animPhase, attackTarget, showHelp, onToggleHelp, floatingDmg, combatModal, onDismissCombat, lootDrop, onDismissLoot }: {
  cr: DungeonCR; onBack: () => void; onAttack: (t: string, d: number) => void; events: WSEvent[]; k8sLog: { ts: string; cmd: string; res: string; yaml?: string }[]
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

      {showHelp && <HelpModal onClose={onToggleHelp} />}

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
      </div>

      <div className="game-layout">
        {/* LEFT PANEL — Dungeon Arena */}
        <div className="left-panel">
          <div className="dungeon-arena">
            {/* Stone floor texture layers */}
            <div className="arena-floor" />
            <div className="arena-glow" />

            {/* Boss — only visible when ready or defeated */}
            {bossState !== 'pending' && (() => {
              let bAction: SpriteAction = bossState === 'defeated' ? 'dead' : 'idle'
              if (attackTarget?.includes('boss') && animPhase === 'hero-attack') bAction = 'hurt'
              if (bossState === 'ready' && animPhase === 'enemy-attack' && attackTarget?.includes('boss')) bAction = 'attack'
              if (status?.victory) bAction = 'dead'
              const bossName = `${dungeonName}-boss`
              return (
                <div className={`arena-entity boss-entity ${bossState === 'defeated' ? 'dead' : ''}`}
                  style={{ top: '8%', left: '50%' }}>
                  {floatingDmg?.target?.includes('boss') && <div className="floating-dmg" style={{ color: '#e94560' }}>{floatingDmg.amount}</div>}
                  <Sprite spriteType="dragon" action={bAction} size={96} />
                  <div className="arena-shadow" style={{ width: 80 }} />
                  <div className="arena-hover-ui">
                    <div className="arena-hp-bar"><div className={`arena-hp-fill ${spec.bossHP > 0 ? 'high' : 'low'}`} style={{ width: `${Math.min((spec.bossHP / maxBossHP) * 100, 100)}%` }} /></div>
                    <div className="arena-name">Boss · {spec.bossHP}/{maxBossHP}</div>
                    {bossState === 'ready' && !gameOver && !attackPhase && (
                      <div className="arena-actions">
                        <button className="btn btn-primary arena-atk-btn" onClick={() => onAttack(bossName, 0)}>🎲 {status?.diceFormula || '2d12+4'}</button>
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
              const mSprite = getMonsterSprite(idx)
              let mAction: SpriteAction = state === 'dead' ? 'dead' : 'idle'
              if (attackTarget === mName && animPhase === 'hero-attack') mAction = 'hurt'
              if (state === 'alive' && animPhase === 'enemy-attack') mAction = 'attack'

              // Position in semicircle (top arc around hero)
              const angle = count === 1 ? Math.PI / 2 : (Math.PI * 0.2) + (Math.PI * 0.6 / (count - 1)) * idx
              const radiusX = 38 // % from center
              const radiusY = 30
              const cx = 50 + Math.cos(angle) * radiusX
              const cy = 45 - Math.sin(angle) * radiusY
              const facingRight = cx < 50

              return (
                <div key={mName} className={`arena-entity monster-entity ${state}`}
                  style={{ left: `${cx}%`, top: `${cy}%` }}>
                  {floatingDmg?.target === mName && <div className="floating-dmg" style={{ color: '#e94560' }}>{floatingDmg.amount}</div>}
                  <Sprite spriteType={mSprite} action={mAction} size={72} flip={!facingRight} />
                  <div className="arena-shadow" />
                  <div className="arena-hover-ui">
                    <div className="arena-hp-bar"><div className={`arena-hp-fill ${hp > maxMonsterHP * 0.6 ? 'high' : hp > maxMonsterHP * 0.3 ? 'mid' : 'low'}`} style={{ width: `${Math.min((hp / maxMonsterHP) * 100, 100)}%` }} /></div>
                    <div className="arena-name">{mSprite} · {hp}/{maxMonsterHP}</div>
                    {state === 'alive' && !gameOver && !attackPhase && (
                      <div className="arena-actions">
                        <button className="btn btn-primary arena-atk-btn" onClick={() => onAttack(mName, 0)}>🎲 {status?.diceFormula || '2d12+4'}</button>
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
                action={isDefeated ? 'dead' : status?.victory ? 'victory' : animPhase === 'hero-attack' ? 'attack' : animPhase === 'enemy-attack' ? 'hurt' : 'idle'} />
              <div className="arena-shadow" style={{ width: 60 }} />
            </div>

            {/* Victory glow */}
            {status?.victory && <div className="arena-victory-glow" />}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div className="right-panel">
          <div className="hero-section">
            <Sprite spriteType={spec.heroClass || 'warrior'} size={80}
              action={isDefeated ? 'dead' : status?.victory ? 'victory' : animPhase === 'hero-attack' ? 'attack' : animPhase === 'enemy-attack' ? 'hurt' : 'idle'} />
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
                <button className="btn btn-ability" disabled={(spec.heroMana ?? 0) < 2 || heroHP >= 80}
                  onClick={() => onAttack('hero', 0)}>
                  <PixelIcon name="heal" size={12} /> Heal
                </button>
              )}
              {spec.heroClass === 'warrior' && (
                <button className={`btn btn-ability${(spec.tauntActive ?? 0) === 1 ? ' active' : ''}`}
                  disabled={(spec.tauntActive ?? 0) >= 1}
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
            const modifier = spec.modifier || 'none'
            const poison = spec.poisonTurns || 0
            const burn = spec.burnTurns || 0
            const stun = spec.stunTurns || 0
            const RARITY_COLOR: Record<string, string> = { common: '#aaa', rare: '#5dade2', epic: '#9b59b6' }
            return (
              <div className="equip-panel">
                <div className="equip-grid">
                  <div className="equip-row"><Tooltip text="Helmet — coming soon"><div className="equip-slot empty"><PixelIcon name="lock" size={14} /></div></Tooltip></div>
                  <div className="equip-row">
                    <Tooltip text="Shield — coming soon"><div className="equip-slot empty"><PixelIcon name="lock" size={14} /></div></Tooltip>
                    <Tooltip text={ab > 0 ? `Armor equipped: +${ab}% damage reduction on counter-attacks` : 'Armor — none equipped'}>
                      <div className={`equip-slot${ab > 0 ? ' filled' : ' empty'}`}>
                        {ab > 0 ? <><ItemSprite id="armor-common" size={22} /><span className="slot-stat">+{ab}%</span></> : <PixelIcon name="shield" size={14} color="#333" />}
                      </div>
                    </Tooltip>
                    <Tooltip text={wb > 0 ? `Weapon equipped: +${wb} bonus damage, ${wu} uses remaining` : 'Weapon — none equipped'}>
                      <div className={`equip-slot${wb > 0 ? ' filled' : ' empty'}`}>
                        {wb > 0 ? <><ItemSprite id="weapon-common" size={22} /><span className="slot-stat">+{wb}</span></> : <PixelIcon name="sword" size={14} color="#333" />}
                      </div>
                    </Tooltip>
                  </div>
                  <div className="equip-row"><Tooltip text="Pants — coming soon"><div className="equip-slot empty"><PixelIcon name="lock" size={14} /></div></Tooltip></div>
                  <div className="equip-row"><Tooltip text="Boots — coming soon"><div className="equip-slot empty"><PixelIcon name="lock" size={14} /></div></Tooltip></div>
                </div>

                <div className="status-row">
                  {modifier !== 'none' && <Tooltip text={`${modifier.startsWith('curse') ? 'Curse' : 'Blessing'}: ${status?.modifier || modifier}`}><div className={`status-badge ${modifier.startsWith('curse') ? 'curse' : 'blessing'}`}><ItemSprite id={modifier} size={18} /></div></Tooltip>}
                  {poison > 0 && <Tooltip text={`Poison: -5 HP per turn, ${poison} turns remaining`}><div className="status-badge effect"><PixelIcon name="poison" size={12} /><span>{poison}</span></div></Tooltip>}
                  {burn > 0 && <Tooltip text={`Burn: -8 HP per turn, ${burn} turns remaining`}><div className="status-badge effect"><PixelIcon name="fire" size={12} /><span>{burn}</span></div></Tooltip>}
                  {stun > 0 && <Tooltip text={`Stun: skip next attack, ${stun} turns remaining`}><div className="status-badge effect"><PixelIcon name="lightning" size={12} /><span>{stun}</span></div></Tooltip>}
                </div>

                {items.length > 0 && (
                  <div className="backpack">
                    <div className="backpack-label">Backpack</div>
                    <div className="backpack-grid">
                      {items.map((item, i) => {
                        const rarity = item.split('-').pop()!
                        const isPotion = item.includes('potion')
                        const desc = item.includes('weapon') ? `Weapon (${rarity}) — click to equip, +damage for 3 attacks` :
                          item.includes('armor') ? `Armor (${rarity}) — click to equip, +defense for dungeon` :
                          item.includes('hppotion') ? `HP Potion (${rarity}) — click to restore HP` :
                          item.includes('manapotion') ? `Mana Potion (${rarity}) — click to restore mana` : item
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

      <EventLogTabs events={events} k8sLog={k8sLog} />
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
