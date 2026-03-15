import { onCLS, onFCP, onLCP, onTTFB, onINP, type Metric } from 'web-vitals'

function sendVital(metric: Metric) {
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
