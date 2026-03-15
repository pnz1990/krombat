import { onCLS, onFCP, onLCP, onTTFB, onINP } from 'web-vitals'

interface VitalMetric {
  name: string
  value: number
  rating: string
}

function sendVital(metric: VitalMetric) {
  fetch('/api/v1/vitals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: metric.name, value: metric.value, rating: metric.rating }),
    keepalive: true,
  }).catch(() => {})
}

export function initVitals() {
  onCLS(sendVital)
  onFCP(sendVital)
  onLCP(sendVital)
  onTTFB(sendVital)
  onINP(sendVital)
}
