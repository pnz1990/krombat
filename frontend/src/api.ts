const BASE = '/api/v1'

// Shared fetch options — include credentials (session cookie) on all API calls.
const CREDS: RequestInit = { credentials: 'include' }

export interface DungeonSummary {
  name: string; namespace: string; difficulty: string
  livingMonsters: number | null; bossState: string | null; victory: boolean | null
  modifier?: string | null; runCount?: number | null
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
  metadata: { name: string; namespace: string; creationTimestamp?: string; labels?: Record<string, string> }
  spec: {
    monsters: number; difficulty: string
    monsterHP: number[]; bossHP: number; heroHP: number
    currentTurn: string; turnRound: number
    heroClass?: string; heroMana?: number
    tauntActive?: number; backstabCooldown?: number
    modifier?: string; inventory?: string
    weaponBonus?: number; weaponUses?: number; armorBonus?: number; shieldBonus?: number
    helmetBonus?: number; pantsBonus?: number; bootsBonus?: number
    ringBonus?: number; amuletBonus?: number
    poisonTurns?: number; burnTurns?: number; stunTurns?: number
    treasureOpened?: number
    currentRoom?: number; doorUnlocked?: number; room2BossHP?: number; room2MonsterHP?: number[]
    monsterTypes?: string[]
    runCount?: number
    lastHeroAction?: string; lastEnemyAction?: string; lastCombatLog?: string; lastLootDrop?: string
    attackSeq?: number; actionSeq?: number
    lastAttackTarget?: string; lastAction?: string; lastAbility?: string
    initProcessedSeq?: number; room2ProcessedSeq?: number
    combatProcessedSeq?: number
  }
  status?: {
    livingMonsters: number; bossState: string; victory: boolean; defeated: boolean
    loot: string; maxMonsterHP: number; maxBossHP: number
    maxHeroHP: number; diceFormula: string; monsterCounter: number; bossCounter: number
    modifier?: string; modifierType?: string; treasureState?: string; bossPhase?: string
    conditions?: KroCondition[]
  }
}

// Auth types
export interface AuthUser {
  login: string
  avatarUrl: string
}

export async function getMe(): Promise<AuthUser | null> {
  try {
    const r = await fetch(`${BASE}/auth/me`, CREDS)
    if (r.status === 401) return null
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, CREDS)
}

export async function listDungeons(): Promise<DungeonSummary[]> {
  const r = await fetch(`${BASE}/dungeons`, CREDS)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function getDungeon(ns: string, name: string): Promise<DungeonCR> {
  const r = await fetch(`${BASE}/dungeons/${ns}/${name}`, CREDS)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function createDungeon(name: string, monsters: number, difficulty: string, heroClass: string = 'warrior', namespace: string = 'default') {
  const r = await fetch(`${BASE}/dungeons`, {
    ...CREDS, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, monsters, difficulty, heroClass, namespace }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export interface NewGamePlusOptions {
  runCount: number
  weaponBonus?: number; weaponUses?: number; armorBonus?: number; shieldBonus?: number
  helmetBonus?: number; pantsBonus?: number; bootsBonus?: number; ringBonus?: number; amuletBonus?: number
}

export async function createNewGamePlus(
  name: string, monsters: number, difficulty: string, heroClass: string,
  opts: NewGamePlusOptions, namespace: string = 'default'
) {
  const r = await fetch(`${BASE}/dungeons`, {
    ...CREDS, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, monsters, difficulty, heroClass, namespace, ...opts }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
export async function deleteDungeon(ns: string, name: string) {
  const r = await fetch(`${BASE}/dungeons/${ns}/${name}`, { ...CREDS, method: 'DELETE' })
  if (!r.ok && r.status !== 204) throw new Error(await r.text())
}

export interface LeaderboardEntry {
  dungeonName: string
  heroClass: string
  difficulty: string
  outcome: string  // 'victory' | 'defeat' | 'room1-cleared' | 'in-progress'
  totalTurns: number
  currentRoom: number
  timestamp: string
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  const r = await fetch(`${BASE}/leaderboard`, CREDS)
  if (!r.ok) return []
  return r.json()
}

export interface UserProfile {
  dungeonsPlayed: number
  dungeonsWon: number
  dungeonsLost: number
  dungeonsAbandoned: number
  totalTurns: number
  totalKills: number
  totalBossKills: number
  favouriteClass: string
  favouriteDifficulty: string
  inventory: string          // CSV
  weaponBonus: number; weaponUses: number; armorBonus: number; shieldBonus: number
  helmetBonus: number; pantsBonus: number; bootsBonus: number; ringBonus: number; amuletBonus: number
  heroHP: number
  heroMana: number
  earnedBadges: string[]
  badgeCounts: Record<string, number>
  xp: number
  level: number
  kroCertificates: string[]
  firstPlayed: string
  lastPlayed: string
}

export async function getProfile(): Promise<UserProfile | null> {
  try {
    const r = await fetch(`${BASE}/profile`, CREDS)
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}


export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

const VALID_RESOURCE_KINDS = [
  'dungeon', 'hero', 'herostate', 'boss', 'bossstate', 'namespace', 'gameconfig',
  'monster', 'monsterstate', 'treasure', 'treasurecm', 'treasuresecret', 'modifier',
  'combatresult', 'combatcm', 'modifiercm', 'actioncm',
] as const
export type ResourceKind = typeof VALID_RESOURCE_KINDS[number]

/** Sanitize Kubernetes resource name/namespace to safe path chars */
function safePath(s: string): string { return s.replace(/[^a-zA-Z0-9\-_.]/g, '').slice(0, 253) }

export async function getDungeonResource(ns: string, name: string, kind: ResourceKind, index?: number): Promise<any> {
  // Same-origin call to /api/v1 only. ns/name are K8s identifiers, sanitized.
  let url = `${BASE}/dungeons/${safePath(ns)}/${safePath(name)}/resources?kind=${kind}`
  if (index !== undefined) url += `&index=${index}`
  const r = await fetch(url, CREDS)
  if (!r.ok) return null
  return r.json()
}

export async function submitAttack(ns: string, dungeon: string, target: string, damage: number, seq?: number) {
  const r = await fetch(`${BASE}/dungeons/${ns}/${dungeon}/attacks`, {
    ...CREDS, method: 'POST', headers: { 'Content-Type': 'application/json' },
    // seq: send the last-known sequence so the backend can detect concurrent
    // writes. Omit (send -1) when seq is unknown to stay backward-compatible.
    body: JSON.stringify({ target, damage, seq: seq ?? -1 }),
  })
  if (!r.ok) throw new ApiError(r.status, await r.text())
  return r.json()
}

/**
 * reportError sends a structured error report to the backend for CloudWatch.
 * Fire-and-forget — never throws.
 */
export function reportError(context: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  fetch('/api/v1/client-error', {
    ...CREDS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, message, url: window.location.href, timestamp: new Date().toISOString() }),
  }).catch(() => {})
}

/**
 * trackEvent sends a game interaction event to the backend for CloudWatch.
 * Fire-and-forget — never throws.
 */
export function trackEvent(event: string, props: Record<string, unknown> = {}) {
  fetch('/api/v1/events-track', {
    ...CREDS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...props, ts: Date.now() }),
    keepalive: true,
  }).catch(() => {})
}

