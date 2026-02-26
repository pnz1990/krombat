const BASE = '/api/v1'

export interface DungeonSummary {
  name: string; namespace: string; difficulty: string
  livingMonsters: number | null; bossState: string | null; victory: boolean | null
}

export interface DungeonDetail {
  dungeon: { metadata: any; spec: any; status: any }
  pods: { items: PodInfo[] } | null
  loot: string
}

export interface PodInfo {
  metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> }
}

export async function listDungeons(): Promise<DungeonSummary[]> {
  const r = await fetch(`${BASE}/dungeons`)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function getDungeon(ns: string, name: string): Promise<DungeonDetail> {
  const r = await fetch(`${BASE}/dungeons/${ns}/${name}`)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function createDungeon(name: string, monsters: number, difficulty: string) {
  const hp = { easy: 30, normal: 50, hard: 80 }[difficulty] || 50
  const bossHp = { easy: 200, normal: 400, hard: 800 }[difficulty] || 400
  const r = await fetch(`${BASE}/dungeons`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, monsters, difficulty, monsterHP: Array(monsters).fill(hp), bossHP: bossHp }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function submitAttack(ns: string, dungeon: string, target: string, damage: number) {
  const r = await fetch(`${BASE}/dungeons/${ns}/${dungeon}/attacks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, damage }),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
