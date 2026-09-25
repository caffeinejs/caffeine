import type { IncomingMessage, Server } from 'node:http'

import { WebSocketServer, type WebSocket } from 'ws'

import type { WsMessage } from '../types.js'

function onWsError() {
  // noop — suppress unhandled error events on individual sockets
}

export class WsBroadcaster {
  private wss: WebSocketServer | null = null

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server })
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      ws.on('error', onWsError)
    })
  }

  broadcast(message: WsMessage): void {
    if (!this.wss) {
      return
    }
    const payload = JSON.stringify(message)
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(payload)
      }
    }
  }

  sendTo(ws: WebSocket, message: WsMessage): void {
    ws.send(JSON.stringify(message))
  }

  onConnection(handler: (ws: WebSocket) => void): void {
    this.wss?.on('connection', handler)
  }

  close(): Promise<void> {
    const wss = this.wss
    this.wss = null

    return new Promise((resolve, reject) => {
      if (!wss) {
        return resolve()
      }
      // `ws` stops accepting on close() but leaves the open connections alone, and the HTTP server under it cannot
      // close while an open devtools tab still holds one.
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close(err => (err ? reject(err) : resolve()))
    })
  }
}
