import { useState, useEffect, useRef } from 'react'

// Sprite sheets: heroes 7 frames (5472x768 = 768px/frame), monsters 6 frames (5088x832 = 848px/frame), boss 7 frames (5472x768)
const SPRITE_CONFIG: Record<string, { frames: number; frameW: number; frameH: number; file: string }> = {
  warrior:  { frames: 7, frameW: 781, frameH: 768, file: '/sprites/warrior.png' },
  mage:     { frames: 7, frameW: 781, frameH: 768, file: '/sprites/mage.png' },
  rogue:    { frames: 7, frameW: 781, frameH: 768, file: '/sprites/rogue.png' },
  goblin:   { frames: 6, frameW: 848, frameH: 832, file: '/sprites/goblin.png' },
  skeleton: { frames: 6, frameW: 848, frameH: 832, file: '/sprites/skeleton.png' },
  dragon:   { frames: 7, frameW: 781, frameH: 768, file: '/sprites/dragon.png' },
}

// Frame indices: 0=idle, 1=walk1, 2=walk2, 3=attack1, 4=attack2, 5=hurt, 6=victory/dead (heroes/boss have 7, monsters have 6)
export type SpriteAction = 'idle' | 'attack' | 'hurt' | 'dead' | 'victory'

const ACTION_FRAMES: Record<SpriteAction, number[]> = {
  idle:    [0],
  attack:  [3, 4],
  hurt:    [5],
  dead:    [5],
  victory: [6],
}

// For monsters with 6 frames, victory/dead uses frame 5 (hurt)
const MONSTER_ACTION_FRAMES: Record<SpriteAction, number[]> = {
  idle:    [0],
  attack:  [3, 4],
  hurt:    [5],
  dead:    [5],
  victory: [5],
}

interface SpriteProps {
  spriteType: string  // warrior, mage, rogue, goblin, skeleton, dragon
  action: SpriteAction
  size?: number       // display size in px
  flip?: boolean      // mirror horizontally (for enemies facing left)
}

export function Sprite({ spriteType, action, size = 64, flip = false }: SpriteProps) {
  const [frameIdx, setFrameIdx] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined)
  const config = SPRITE_CONFIG[spriteType]

  if (!config) return <div style={{ width: size, height: size, fontSize: size * 0.6, textAlign: 'center' }}>👹</div>

  const isMonster = spriteType === 'goblin' || spriteType === 'skeleton'
  const frames = isMonster ? MONSTER_ACTION_FRAMES[action] : ACTION_FRAMES[action]

  useEffect(() => {
    setFrameIdx(0)
    if (frames.length > 1) {
      let idx = 0
      intervalRef.current = setInterval(() => {
        idx = (idx + 1) % frames.length
        setFrameIdx(idx)
      }, 200)
      return () => clearInterval(intervalRef.current)
    }
  }, [action, spriteType])

  const frame = frames[frameIdx] ?? frames[0]
  const scale = size / config.frameH

  return (
    <div style={{
      width: size,
      height: size,
      overflow: 'hidden',
      imageRendering: 'pixelated' as any,
      transform: flip ? 'scaleX(-1)' : undefined,
    }}>
      <div style={{
        width: config.frameW * scale,
        height: config.frameH * scale,
        backgroundImage: `url(${config.file})`,
        backgroundSize: `${config.frames * config.frameW * scale}px ${config.frameH * scale}px`,
        backgroundPosition: `-${frame * config.frameW * scale}px 0`,
      }} />
    </div>
  )
}

// Assign a deterministic monster sprite based on index
export function getMonsterSprite(index: number): string {
  return index % 2 === 0 ? 'goblin' : 'skeleton'
}
