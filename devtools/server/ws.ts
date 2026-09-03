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
    return new Promise((resolve, reject) => {
      if (!this.wss) {
        return resolve()
      }
      this.wss.close(err => (err ? reject(err) : resolve()))
    })
  }
}
