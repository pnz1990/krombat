// 8-bit pixel art icons as inline SVGs — consistent cross-platform rendering
// Each icon is a tiny pixel grid rendered as an SVG for crisp scaling

const ICONS: Record<string, { color: string; pixels: string }> = {
  sword:    { color: '#c0c0c0', pixels: '1,7 2,6 3,5 4,4 5,3 6,2 7,1 5,5 4,6 3,7 6,4 7,5' },
  shield:   { color: '#f5c518', pixels: '2,1 3,1 4,1 5,1 6,1 1,2 7,2 1,3 7,3 1,4 7,4 2,5 6,5 3,6 5,6 4,7' },
  skull:    { color: '#e0e0e0', pixels: '3,1 4,1 5,1 2,2 6,2 2,3 4,3 6,3 2,4 6,4 3,5 5,5 2,6 4,6 6,6 3,7 5,7' },
  potion:   { color: '#dc143c', pixels: '4,1 4,2 3,3 5,3 2,4 6,4 2,5 6,5 2,6 6,6 3,7 5,7' },
  scroll:   { color: '#d2b48c', pixels: '2,1 3,1 4,1 5,1 6,1 2,2 6,2 2,3 6,3 2,4 6,4 2,5 6,5 2,6 3,6 4,6 5,6 6,6' },
  crown:    { color: '#f5c518', pixels: '1,3 3,1 4,3 5,1 7,3 1,4 7,4 1,5 2,5 3,5 4,5 5,5 6,5 7,5 1,6 7,6' },
  dragon:   { color: '#dc143c', pixels: '2,1 6,1 1,2 3,2 5,2 7,2 2,3 6,3 3,4 4,4 5,4 2,5 6,5 1,6 3,6 5,6 7,6' },
  fire:     { color: '#ff4500', pixels: '4,1 3,2 5,2 2,3 4,3 6,3 2,4 6,4 3,5 5,5 3,6 5,6 4,7' },
  poison:   { color: '#32cd32', pixels: '4,1 3,2 5,2 2,3 6,3 2,4 6,4 3,5 5,5 4,6 4,7' },
  lightning:{ color: '#ffd700', pixels: '5,1 4,2 3,3 4,3 5,3 6,3 5,4 4,5 3,6 4,7' },
  heart:    { color: '#e94560', pixels: '2,2 3,1 5,1 6,2 1,3 7,3 1,4 7,4 2,5 6,5 3,6 5,6 4,7' },
  mana:     { color: '#4169e1', pixels: '4,1 3,2 5,2 2,3 6,3 2,4 6,4 3,5 5,5 4,6' },
  dice:     { color: '#e0e0e0', pixels: '2,1 3,1 4,1 5,1 6,1 1,2 7,2 1,3 3,3 5,3 7,3 1,4 4,4 7,4 1,5 3,5 5,5 7,5 1,6 7,6 2,7 3,7 4,7 5,7 6,7' },
  chest:    { color: '#8b4513', pixels: '1,2 2,2 3,2 4,2 5,2 6,2 7,2 1,3 7,3 1,4 4,4 7,4 1,5 7,5 1,6 2,6 3,6 4,6 5,6 6,6 7,6' },
  star:     { color: '#f5c518', pixels: '4,1 3,3 1,3 3,5 2,7 4,5 6,7 5,5 7,3 5,3' },
  dagger:   { color: '#c0c0c0', pixels: '4,1 4,2 4,3 4,4 3,5 5,5 4,5 4,6 4,7' },
  heal:     { color: '#32cd32', pixels: '4,2 4,3 3,4 4,4 5,4 4,5 4,6' },
  lock:     { color: '#888', pixels: '3,1 4,1 5,1 2,2 6,2 2,3 6,3 1,4 7,4 1,5 4,5 7,5 1,6 7,6 2,7 3,7 4,7 5,7 6,7' },
  book:     { color: '#d2b48c', pixels: '2,1 3,1 4,1 5,1 6,1 1,2 7,2 1,3 4,3 7,3 1,4 7,4 1,5 4,5 7,5 2,6 3,6 4,6 5,6 6,6' },
  key:      { color: '#f5c518', pixels: '3,1 4,1 2,2 5,2 3,3 4,3 5,4 5,5 6,5 5,6 5,7 6,7' },
  damage:   { color: '#e94560', pixels: '1,1 7,1 2,2 6,2 3,3 5,3 4,4 3,5 5,5 2,6 6,6 1,7 7,7' },
}

function parsePixels(pixels: string): [number, number][] {
  return pixels.split(' ').map(p => {
    const [x, y] = p.split(',').map(Number)
    return [x, y] as [number, number]
  })
}

export function PixelIcon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  const icon = ICONS[name]
  if (!icon) return <span style={{ fontSize: size * 0.8 }}>?</span>
  const c = color || icon.color
  const scale = size / 8
  const points = parsePixels(icon.pixels)
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" style={{ imageRendering: 'pixelated' as any, display: 'inline-block', verticalAlign: 'middle' }}>
      {points.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={1} height={1} fill={c} />
      ))}
    </svg>
  )
}
