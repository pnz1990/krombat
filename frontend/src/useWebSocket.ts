import { useEffect, useRef, useCallback, useState } from 'react'

export interface WSEvent {
  type: string; action: string; name: string; namespace: string; payload: any
}

export function useWebSocket(onEvent: (e: WSEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)

  const connect = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${window.location.host}/api/v1/events`)
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => { setConnected(false); setTimeout(connect, 3000) }
    ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)) } catch {} }
  }, [onEvent])

  useEffect(() => { connect(); return () => wsRef.current?.close() }, [connect])
  return connected
}
