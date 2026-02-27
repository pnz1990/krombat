const BASE = '/api/v1'

export interface DungeonSummary {
  name: string; namespace: string; difficulty: string
  livingMonsters: number | null; bossState: string | null; victory: boolean | null
}

// GetDungeon now returns the raw Dungeon CR — all state is in spec + status
export interface DungeonCR {
  metadata: { name: string; namespace: string }
  spec: {
    monsters: number; difficulty: string
    monsterHP: number[]; bossHP: number; heroHP: number
    currentTurn: string; turnRound: number
    heroClass?: string; heroMana?: number
    tauntActive?: number; backstabCooldown?: number
    modifier?: string; inventory?: string
    weaponBonus?: number; weaponUses?: number; armorBonus?: number
    poisonTurns?: number; burnTurns?: number; stunTurns?: number
    lastHeroAction?: string; lastEnemyAction?: string
  }
  status?: {
    livingMonsters: number; bossState: string; victory: boolean; defeated: boolean
    loot: string; maxMonsterHP: number; maxBossHP: number
    modifier?: string; modifierType?: string
  }
}

export async function listDungeons(): Promise<DungeonSummary[]> {
  const r = await fetch(`${BASE}/dungeons`)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function getDungeon(ns: string, name: string): Promise<DungeonCR> {
  const r = await fetch(`${BASE}/dungeons/${ns}/${name}`)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function createDungeon(name: string, monsters: number, difficulty: string, heroClass: string = 'warrior') {
  const r = await fetch(`${BASE}/dungeons`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, monsters, difficulty, heroClass }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
export async function deleteDungeon(ns: string, name: string) {
  const r = await fetch(`${BASE}/dungeons/${ns}/${name}`, { method: 'DELETE' })
  if (!r.ok && r.status !== 204) throw new Error(await r.text())
}


export async function submitAttack(ns: string, dungeon: string, target: string, damage: number) {
  const r = await fetch(`${BASE}/dungeons/${ns}/${dungeon}/attacks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, damage }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
