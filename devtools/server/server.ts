import { createServer, type Server } from 'node:http'
import type { WebApplication } from '@caffeinejs/http'
import { HttpCollector } from '../collectors/application.collector.js'
import { DevtoolsStore } from '../store.js'
import type { DevtoolsEvent } from '../types.js'
import { serveStatic } from './static.js'
import { WsBroadcaster } from './ws.js'

export interface DevtoolsOptions {
  port?: number
}

export class DevtoolsServer {
  private readonly store = new DevtoolsStore()
  private readonly ws = new WsBroadcaster()
  private server: Server | null = null
  private readonly httpCollector = new HttpCollector(this.store)

  constructor(private readonly options: DevtoolsOptions = {}) {}

  get _store(): DevtoolsStore {
    return this.store
  }

  broadcast(event: DevtoolsEvent): void {
    this.ws.broadcast({ type: 'event', event })
  }

  attach(app: WebApplication<any, any, any>): this {
    this.httpCollector.attach(app)
    return this
  }

  start(): this {
    const port = this.options.port ?? 9229

    this.server = createServer((req, res) => {
      if (!serveStatic(req, res)) {
        res.writeHead(404)
        res.end()
      }
    })

    this.ws.attach(this.server)

    this.ws.onConnection(ws => {
      this.ws.sendTo(ws, {
        type: 'snapshot',
        bindings: this.store.bindings,
        graph: this.store.graph,
        routes: this.store.routes,
        events: this.store.events,
      })
    })

    this.server.listen(port, () => {
      console.log(`[caffeine:devtools] running at http://localhost:${port}`)
    })

    return this
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.close().then(() => {
        if (!this.server) {
          return resolve()
        }
        this.server.close(err => (err ? reject(err) : resolve()))
      }, reject)
    })
  }
}
