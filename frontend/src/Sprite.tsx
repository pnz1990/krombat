import { useState, useEffect, useRef } from 'react'

// Individual frame images: /sprites/{type}/{1-7}.png
// Heroes/boss: 7 frames, monsters: 6 frames
// Frame mapping: 1=idle, 2=walk1, 3=walk2, 4=attack1, 5=attack2, 6=hurt, 7=victory/dead
const FRAME_COUNT: Record<string, number> = {
  warrior: 7, mage: 7, rogue: 7, dragon: 7, goblin: 6, skeleton: 6,
}

export type SpriteAction = 'idle' | 'attack' | 'hurt' | 'dead' | 'victory'

// Map actions to frame numbers (1-indexed file names)
// 1=idle, 2=walk1, 3=walk2, 4=attack1, 5=attack2, 6=hurt, 7=victory/dead
const ACTION_FRAMES: Record<SpriteAction, number[]> = {
  idle:    [1, 2, 3, 2],   // breathing/shifting animation loop
  attack:  [3, 4, 5, 4],
  hurt:    [6],
  dead:    [6],
  victory: [7],
}

const MONSTER_ACTION_FRAMES: Record<SpriteAction, number[]> = {
  idle:    [1, 2, 3, 2],   // breathing/shifting animation loop
  attack:  [3, 4, 5, 4],
  hurt:    [6],
  dead:    [6],
  victory: [6],
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

  if (!FRAME_COUNT[spriteType]) return <div style={{ width: size, height: size, fontSize: size * 0.6, textAlign: 'center' }}>👹</div>

  const isMonster = spriteType === 'goblin' || spriteType === 'skeleton'
  const frames = isMonster ? MONSTER_ACTION_FRAMES[action] : ACTION_FRAMES[action]

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
      }}
    />
  )
}

// Assign a deterministic monster sprite based on index
export function getMonsterSprite(index: number): string {
  return index % 2 === 0 ? 'goblin' : 'skeleton'
}

// Item/icon sprite strips: 6 frames each, ~848px per frame, 832px tall (same scale as monsters)
const ITEM_STRIP: Record<string, { frames: number; frameW: number; frameH: number; file: string }> = {
  weapons:   { frames: 6, frameW: 853, frameH: 832, file: '/sprites/items/weapons.png' },
  armor:     { frames: 6, frameW: 848, frameH: 832, file: '/sprites/items/armor.png' },
  potions:   { frames: 6, frameW: 848, frameH: 832, file: '/sprites/items/potions.png' },
}

// Map item type+rarity to strip and index
const ITEM_MAP: Record<string, { strip: string; index: number }> = {
  'weapon-common':     { strip: 'weapons', index: 0 },
  'weapon-rare':       { strip: 'weapons', index: 1 },
  'weapon-epic':       { strip: 'weapons', index: 2 },
  'armor-common':      { file: '/sprites/items/armor/1.png' },
  'armor-rare':        { file: '/sprites/items/armor/2.png' },
  'armor-epic':        { file: '/sprites/items/armor/3.png' },
  'shield-common':     { file: '/sprites/items/shield/1.png' },
  'shield-rare':       { file: '/sprites/items/shield/2.png' },
  'shield-epic':       { file: '/sprites/items/shield/3.png' },
  'hppotion-common':   { strip: 'potions', index: 0 },
  'hppotion-rare':     { strip: 'potions', index: 1 },
  'hppotion-epic':     { strip: 'potions', index: 2 },
  'manapotion-common': { strip: 'potions', index: 3 },
  'manapotion-rare':   { strip: 'potions', index: 4 },
  'manapotion-epic':   { strip: 'potions', index: 5 },
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
  const mapping: any = ITEM_MAP[id] || MODIFIER_MAP[id]
  if (!mapping) return <span style={{ fontSize: size * 0.6 }}>📦</span>

  // Individual image file
  if (mapping.file) {
    return <img src={mapping.file} alt={id} style={{ width: size, height: size, objectFit: 'contain', imageRendering: 'pixelated' as any, display: 'inline-block' }} />
  }

  // Strip-based
  const strip = ITEM_STRIP[mapping.strip]
  if (!strip) return <span style={{ fontSize: size * 0.6 }}>📦</span>
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
        backgroundPosition: `-${mapping.index * strip.frameW * scale}px 0`,
      }} />
    </div>
  )
}
