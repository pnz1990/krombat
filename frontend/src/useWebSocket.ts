import { useEffect, useRef, useState } from 'react'

export interface WSEvent {
  type: string; action: string; name: string; namespace: string; payload: any
}

export function useWebSocket(namespace?: string, name?: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null)

  useEffect(() => {
    if (!namespace || !name) return
    let alive = true
    let reconnectTimer: ReturnType<typeof setTimeout>

    function connect() {
      if (!alive) return
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/api/v1/events?namespace=${namespace}&name=${name}`)
      wsRef.current = ws

      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (alive) reconnectTimer = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
      ws.onmessage = (e) => {
        try { setLastEvent(JSON.parse(e.data)) } catch {}
      }
    }

    connect()
    return () => { alive = false; clearTimeout(reconnectTimer); wsRef.current?.close() }
  }, [namespace, name])

  return { connected, lastEvent }
}
