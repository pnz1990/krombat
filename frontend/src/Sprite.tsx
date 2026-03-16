import { useState, useEffect, useRef } from 'react'

// Individual frame images: /sprites/{type}/{1-7}.png
// Heroes/boss: 7 frames, monsters: 6 frames
// Frame mapping: 1=idle, 2=walk1, 3=walk2, 4=attack1, 5=attack2, 6=hurt, 7=victory/dead
const FRAME_COUNT: Record<string, number> = {
  warrior: 7, mage: 7, rogue: 7, dragon: 7, goblin: 6, skeleton: 6, troll: 6, ghoul: 6, 'bat-boss': 7,
  archer: 6, shaman: 6,
}

export type SpriteAction = 'idle' | 'attack' | 'hurt' | 'dead' | 'victory' | 'itemUse'

// Map actions to frame numbers (1-indexed file names)
// 1=idle, 2=walk1, 3=walk2, 4=attack1, 5=attack2, 6=hurt, 7=victory/dead
const ACTION_FRAMES: Record<SpriteAction, number[]> = {
  idle:    [1, 2, 3, 2],
  attack:  [3, 4, 5, 4],
  hurt:    [6, 1, 6],
  dead:    [6],
  victory: [7],
  itemUse: [1, 2, 7, 2],
}

const MONSTER_ACTION_FRAMES: Record<SpriteAction, number[]> = {
  idle:    [1, 2, 3, 2],
  attack:  [3, 4, 5, 4],
  hurt:    [6, 1, 6],
  dead:    [6],
  victory: [6],
  itemUse: [1],
}

const BOSS_ACTION_FRAMES: Record<SpriteAction, number[]> = {
  idle:    [1, 2, 3, 2],
  attack:  [4, 5, 6, 5],
  hurt:    [6, 1, 6],
  dead:    [6],
  victory: [7],
  itemUse: [1],
}

interface SpriteProps {
  spriteType: string
  action: SpriteAction
  size?: number
  flip?: boolean
}

export function Sprite({ spriteType, action, size = 64, flip = false }: SpriteProps) {
  const [frameIdx, setFrameIdx] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined)

  if (!FRAME_COUNT[spriteType]) return <div style={{ width: size, height: size, fontSize: size * 0.4, textAlign: 'center', lineHeight: `${size}px`, color: '#e94560', fontFamily: 'monospace' }}>?</div>

  const isBoss = spriteType === 'dragon' || spriteType === 'bat-boss'
  const isMonster = spriteType === 'goblin' || spriteType === 'skeleton' || spriteType === 'troll' || spriteType === 'ghoul' || spriteType === 'archer' || spriteType === 'shaman'
  const frames = isBoss ? BOSS_ACTION_FRAMES[action] : isMonster ? MONSTER_ACTION_FRAMES[action] : ACTION_FRAMES[action]

  useEffect(() => {
    setFrameIdx(0)
    if (frames.length > 1) {
      let idx = 0
      const speed = action === 'idle' ? 400 : 200  // idle slower, attack faster
      intervalRef.current = setInterval(() => {
        idx = (idx + 1) % frames.length
        setFrameIdx(idx)
      }, speed)
      return () => clearInterval(intervalRef.current)
    }
  }, [action, spriteType])

  const frame = frames[frameIdx] ?? frames[0]
  const src = `/sprites/${spriteType}/${frame}.png`

  return (
    <img
      src={src}
      alt={spriteType}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        imageRendering: 'pixelated' as any,
        transform: flip ? 'scaleX(-1)' : undefined,
        opacity: action === 'dead' ? 0.35 : 1,
      }}
    />
  )
}

// Assign a deterministic monster sprite based on index and optional type array.
// Archer maps to 'goblin' sprite (ranged variant), Shaman maps to 'skeleton' sprite (magic variant).
// Falls back to index-based assignment for old dungeons without monsterTypes.
export function getMonsterSprite(index: number, room: number = 1, monsterTypes?: string[]): string {
  const mtype = monsterTypes?.[index]
  if (mtype) {
    switch (mtype) {
      case 'goblin': return 'goblin'
      case 'skeleton': return 'skeleton'
      case 'archer': return 'archer'
      case 'shaman': return 'shaman'
      case 'troll': return 'troll'
      case 'ghoul': return 'ghoul'
      default: break
    }
  }
  if (room === 2) return index % 2 === 0 ? 'troll' : 'ghoul'
  return index % 2 === 0 ? 'goblin' : 'skeleton'
}

// Get the display name for a monster (shown in arena label)
export function getMonsterName(index: number, room: number = 1, monsterTypes?: string[]): string {
  const mtype = monsterTypes?.[index]
  if (mtype) {
    switch (mtype) {
      case 'goblin': return 'Goblin'
      case 'skeleton': return 'Skeleton'
      case 'archer': return 'Archer'
      case 'shaman': return 'Shaman'
      case 'troll': return 'Troll'
      case 'ghoul': return 'Ghoul'
    }
  }
  if (room === 2) return index % 2 === 0 ? 'troll' : 'ghoul'
  return index % 2 === 0 ? 'goblin' : 'skeleton'
}

// Item/icon sprites: individual files per rarity
const ITEM_STRIP: Record<string, { frames: number; frameW: number; frameH: number; file: string }> = {
}

// Map item type+rarity to file path
type ItemMapEntry = { strip: string; index: number; file?: never } | { file: string; strip?: never; index?: never }
const ITEM_MAP: Record<string, ItemMapEntry> = {
  'weapon-common':     { file: '/sprites/weapons/1.png' },
  'weapon-rare':       { file: '/sprites/weapons/2.png' },
  'weapon-epic':       { file: '/sprites/weapons/3.png' },
  'armor-common':      { file: '/sprites/armor/1.png' },
  'armor-rare':        { file: '/sprites/armor/2.png' },
  'armor-epic':        { file: '/sprites/armor/3.png' },
  'shield-common':     { file: '/sprites/shield/1.png' },
  'shield-rare':       { file: '/sprites/shield/2.png' },
  'shield-epic':       { file: '/sprites/shield/3.png' },
  'hppotion-common':   { file: '/sprites/potions/hp-1.png' },
  'hppotion-rare':     { file: '/sprites/potions/hp-2.png' },
  'hppotion-epic':     { file: '/sprites/potions/hp-3.png' },
  'manapotion-common': { file: '/sprites/potions/mana-1.png' },
  'manapotion-rare':   { file: '/sprites/potions/mana-2.png' },
  'manapotion-epic':   { file: '/sprites/potions/mana-3.png' },
  'helmet-common':     { file: '/sprites/helmet/1.png' },
  'helmet-rare':       { file: '/sprites/helmet/2.png' },
  'helmet-epic':       { file: '/sprites/helmet/3.png' },
  'pants-common':      { file: '/sprites/pants/1.png' },
  'pants-rare':        { file: '/sprites/pants/2.png' },
  'pants-epic':        { file: '/sprites/pants/3.png' },
  'boots-common':      { file: '/sprites/boots/1.png' },
  'boots-rare':        { file: '/sprites/boots/2.png' },
  'boots-epic':        { file: '/sprites/boots/3.png' },
  'ring-common':       { file: '/sprites/ring/1.png' },
  'ring-rare':         { file: '/sprites/ring/2.png' },
  'ring-epic':         { file: '/sprites/ring/3.png' },
  'amulet-common':     { file: '/sprites/amulet/1.png' },
  'amulet-rare':       { file: '/sprites/amulet/2.png' },
  'amulet-epic':       { file: '/sprites/amulet/3.png' },
}

const MODIFIER_MAP: Record<string, { file: string }> = {
  'curse-fortitude':      { file: '/sprites/icons/curses/fortitude.png' },
  'curse-fury':           { file: '/sprites/icons/curses/fury.png' },
  'curse-darkness':       { file: '/sprites/icons/curses/darkness.png' },
  'blessing-strength':    { file: '/sprites/icons/blessings/strength.png' },
  'blessing-resilience':  { file: '/sprites/icons/blessings/resilience.png' },
  'blessing-fortune':     { file: '/sprites/icons/blessings/fortune.png' },
}

export function ItemSprite({ id, size = 24 }: { id: string; size?: number }) {
  const mapping: { strip?: string; index?: number; file?: string } | undefined = ITEM_MAP[id] || MODIFIER_MAP[id]
  if (!mapping) return <span style={{ fontSize: size * 0.6, fontFamily: 'monospace' }}>?</span>

  // Individual image file
  if (mapping.file) {
    return <img src={mapping.file} alt={id} style={{ width: size, height: size, objectFit: 'contain', imageRendering: 'pixelated' as any, display: 'inline-block' }} />
  }

  // Strip-based
  const strip = ITEM_STRIP[mapping.strip ?? '']
  if (!strip) return <span style={{ fontSize: size * 0.6, fontFamily: 'monospace' }}>?</span>
  const scale = size / strip.frameH
  return (
    <div style={{
      width: size, height: size, overflow: 'hidden',
      imageRendering: 'pixelated' as any, display: 'inline-block',
    }}>
      <div style={{
        width: strip.frameW * scale,
        height: strip.frameH * scale,
        backgroundImage: `url(${strip.file})`,
        backgroundSize: `${strip.frames * strip.frameW * scale}px ${strip.frameH * scale}px`,
        backgroundPosition: `-${(mapping.index ?? 0) * strip.frameW * scale}px 0`,
      }} />
    </div>
  )
}
