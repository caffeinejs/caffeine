import { useEffect, useRef, useState } from 'react'
import type { WsMessage } from './protocol.js'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 16000

export function useDevtoolsWs(onMessage: (msg: WsMessage) => void) {
  const [connected, setConnected] = useState(false)
  const cbRef = useRef(onMessage)
  cbRef.current = onMessage

  useEffect(() => {
    let ws: WebSocket | null = null
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    function connect() {
      if (destroyed) {
        return
      }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}`)

      ws.onopen = () => {
        attempt = 0
        setConnected(true)
      }

      ws.onclose = () => {
        setConnected(false)
        schedule()
      }

      ws.onerror = () => {
        ws?.close()
      }

      ws.onmessage = ev => {
        try {
          cbRef.current(JSON.parse(ev.data as string) as WsMessage)
        } catch {
          // noop — malformed JSON from server is silently ignored
        }
      }
    }

    function schedule() {
      if (destroyed) {
        return
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
      attempt++
      timer = setTimeout(connect, delay)
    }

    connect()

    return () => {
      destroyed = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      ws?.close()
    }
  }, [])

  return connected
}
