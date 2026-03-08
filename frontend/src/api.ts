const BASE = '/api/v1'

export interface DungeonSummary {
  name: string; namespace: string; difficulty: string
  livingMonsters: number | null; bossState: string | null; victory: boolean | null
  modifier?: string | null
}

// GetDungeon now returns the raw Dungeon CR — all state is in spec + status
export interface KroCondition {
  type: string       // e.g. "Ready", "Error"
  status: string     // "True" or "False"
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface DungeonCR {
  metadata: { name: string; namespace: string; creationTimestamp?: string }
  spec: {
    monsters: number; difficulty: string
    monsterHP: number[]; bossHP: number; heroHP: number
    currentTurn: string; turnRound: number
    heroClass?: string; heroMana?: number
    tauntActive?: number; backstabCooldown?: number
    modifier?: string; inventory?: string
    weaponBonus?: number; weaponUses?: number; armorBonus?: number; shieldBonus?: number
    helmetBonus?: number; pantsBonus?: number; bootsBonus?: number
    poisonTurns?: number; burnTurns?: number; stunTurns?: number
    treasureOpened?: number
    currentRoom?: number; doorUnlocked?: number; room2BossHP?: number
    lastHeroAction?: string; lastEnemyAction?: string; lastCombatLog?: string; lastLootDrop?: string
    attackSeq?: number; actionSeq?: number
  }
  status?: {
    livingMonsters: number; bossState: string; victory: boolean; defeated: boolean
    loot: string; maxMonsterHP: number; maxBossHP: number
    maxHeroHP: number; diceFormula: string; monsterCounter: number; bossCounter: number
    modifier?: string; modifierType?: string; treasureState?: string
    conditions?: KroCondition[]
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

export async function createDungeon(name: string, monsters: number, difficulty: string, heroClass: string = 'warrior', namespace: string = 'default') {
  const r = await fetch(`${BASE}/dungeons`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, monsters, difficulty, heroClass, namespace }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
export async function deleteDungeon(ns: string, name: string) {
  const r = await fetch(`${BASE}/dungeons/${ns}/${name}`, { method: 'DELETE' })
  if (!r.ok && r.status !== 204) throw new Error(await r.text())
}


export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

const VALID_RESOURCE_KINDS = ['dungeon', 'hero', 'herostate', 'boss', 'bossstate', 'namespace', 'gameconfig'] as const
export type ResourceKind = typeof VALID_RESOURCE_KINDS[number]

/** Restrict to safe path chars (alphanumeric + hyphen/dot) to prevent path traversal */
function safePath(s: string): string { return s.replace(/[^a-zA-Z0-9\-_.]/g, '') }

export async function getDungeonResource(ns: string, name: string, kind: ResourceKind): Promise<any> {
  const r = await fetch(`${BASE}/dungeons/${safePath(ns)}/${safePath(name)}/resources?kind=${kind}`)
  if (!r.ok) return null
  return r.json()
}

export async function submitAttack(ns: string, dungeon: string, target: string, damage: number, seq?: number) {
  const r = await fetch(`${BASE}/dungeons/${ns}/${dungeon}/attacks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // seq: send the last-known sequence so the backend can detect concurrent
    // writes. Omit (send -1) when seq is unknown to stay backward-compatible.
    body: JSON.stringify({ target, damage, seq: seq ?? -1 }),
  })
  if (!r.ok) throw new ApiError(r.status, await r.text())
  return r.json()
}
