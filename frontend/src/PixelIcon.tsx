// Sprite-based icons — PNGs from /sprites/icons/ with SVG pixel art fallback
// for icons that don't have a PNG yet (book, lock, damage, key)

// Map icon name → PNG path. Effects map to their icons/effects/ files.
const ICON_PNG: Record<string, string> = {
  sword:     '/sprites/icons/ui/sword.png',
  shield:    '/sprites/icons/ui/shield.png',
  skull:     '/sprites/icons/ui/skull.png',
  dagger:    '/sprites/icons/ui/dagger.png',
  dice:      '/sprites/icons/ui/dice.png',
  heart:     '/sprites/icons/ui/heart.png',
  crown:     '/sprites/icons/ui/crown.png',
  heal:      '/sprites/icons/ui/heal.png',
  potion:    '/sprites/icons/ui/potion.png',
  scroll:    '/sprites/icons/ui/scroll.png',
  dragon:    '/sprites/icons/ui/dragon.png',
  fire:      '/sprites/icons/ui/fire.png',
  lightning: '/sprites/icons/ui/lightning.png',
  mana:      '/sprites/icons/ui/mana.png',
  star:      '/sprites/icons/ui/star.png',
  chest:     '/sprites/icons/ui/chest.png',
  // status effects
  poison:    '/sprites/icons/effects/poison.png',
  burn:      '/sprites/icons/effects/burn.png',
  stun:      '/sprites/icons/effects/stun.png',
  // equipment slot placeholders (used in empty slots)
  helmet:        '/sprites/icons/ui/helmet-slot.png',
  pants:         '/sprites/icons/ui/pants-slot.png',
  boots:         '/sprites/icons/ui/boots-slot.png',
  ring:          '/sprites/icons/ui/ring-slot.png',
  amulet:        '/sprites/icons/ui/amulet-slot.png',
  'weapon-slot': '/sprites/icons/ui/weapon-slot.png',
}

// SVG fallback for icons without a PNG
const SVG_ICONS: Record<string, { color: string; pixels: string }> = {
  book:   { color: '#d2b48c', pixels: '2,1 3,1 4,1 5,1 6,1 1,2 7,2 1,3 4,3 7,3 1,4 7,4 1,5 4,5 7,5 2,6 3,6 4,6 5,6 6,6' },
  lock:   { color: '#888',    pixels: '3,1 4,1 5,1 2,2 6,2 2,3 6,3 1,4 7,4 1,5 4,5 7,5 1,6 7,6 2,7 3,7 4,7 5,7 6,7' },
  damage: { color: '#e94560', pixels: '1,1 7,1 2,2 6,2 3,3 5,3 4,4 3,5 5,5 2,6 6,6 1,7 7,7' },
  key:    { color: '#f5c518', pixels: '3,1 4,1 2,2 5,2 3,3 4,3 5,4 5,5 6,5 5,6 5,7 6,7' },
}

function parsePixels(pixels: string): [number, number][] {
  return pixels.split(' ').map(p => {
    const [x, y] = p.split(',').map(Number)
    return [x, y] as [number, number]
  })
}

export function PixelIcon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  const pngSrc = ICON_PNG[name]
  if (pngSrc) {
    return (
      <img
        src={pngSrc}
        alt={name}
        width={size}
        height={size}
        style={{
          imageRendering: 'pixelated' as any,
          display: 'inline-block',
          verticalAlign: 'middle',
          opacity: color === '#333' ? 0.25 : 1,
        }}
      />
    )
  }

  // SVG fallback for book / lock / damage / key
  const icon = SVG_ICONS[name]
  if (!icon) return <span style={{ fontSize: size * 0.8 }}>?</span>
  const c = color || icon.color
  const points = parsePixels(icon.pixels)
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" style={{ imageRendering: 'pixelated' as any, display: 'inline-block', verticalAlign: 'middle' }}>
      {points.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={1} height={1} fill={c} />
      ))}
    </svg>
  )
}
