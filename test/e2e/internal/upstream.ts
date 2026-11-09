import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** What the dependency does with one request. */
export type Reply =
  | {
      readonly status: number
      readonly body?: unknown
      readonly headers?: Record<string, string>
      readonly delay?: number
    }
  | 'hang'
  | 'reset'

export interface Arrival {
  /** `performance.now()` when the request arrived. */
  readonly at: number
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
}

/**
 * A scripted dependency on a real socket: each request takes the next scripted reply, or the default once the script
 * runs out. It records every arrival, counts what is in flight, and says when a client gave up on a request it had
 * not answered yet.
 */
export interface Upstream {
  readonly port: number
  readonly origin: string
  readonly arrivals: readonly Arrival[]
  readonly inFlight: number
  readonly peakInFlight: number
  /** Queues replies for the next requests, in order. */
  script(...replies: Reply[]): void
  /** The reply for every request once the script is spent. */
  setDefault(reply: Reply): void
  /** Resolves when `count` requests in all have arrived. */
  arrived(count: number): Promise<void>
  /** Resolves when `count` requests in all were closed by their client before they were answered. */
  abandoned(count: number): Promise<void>
  /** Answers every request held by `'hang'` with `reply`. */
  releaseHung(reply?: Reply): void
  close(): Promise<void>
}

export async function startUpstream(defaultReply: Reply = { status: 200, body: { ok: true } }): Promise<Upstream> {
  const queue: Reply[] = []
  const arrivals: Arrival[] = []
  const hung = new Set<ServerResponse>()
  const waiters: Array<{ count: number; kind: 'arrived' | 'abandoned'; resolve: () => void }> = []
  let fallback = defaultReply
  let inFlight = 0
  let peakInFlight = 0
  let abandoned = 0

  const notify = (): void => {
    for (const waiter of [...waiters]) {
      const reached = waiter.kind === 'arrived' ? arrivals.length >= waiter.count : abandoned >= waiter.count
      if (reached) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }

  const answer = (res: ServerResponse, reply: Exclude<Reply, 'hang' | 'reset'>): void => {
    if (res.writableEnded || res.destroyed) {
      return
    }
    const send = (): void => {
      if (res.writableEnded || res.destroyed) {
        return
      }
      // No keep-alive: a pooled socket would outlive this server, and the next one on a reused port would get it.
      res.writeHead(reply.status, { 'content-type': 'application/json', connection: 'close', ...reply.headers })
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
    }
    if (reply.delay !== undefined && reply.delay > 0) {
      setTimeout(send, reply.delay)
    } else {
      send()
    }
  }

  const server = createServer((req, res) => {
    arrivals.push({ at: performance.now(), method: req.method ?? '', path: req.url ?? '', headers: req.headers })
    inFlight++
    peakInFlight = Math.max(peakInFlight, inFlight)
    let settled = false
    const done = (): void => {
      if (!settled) {
        settled = true
        inFlight--
      }
    }
    res.on('finish', done)
    res.on('close', () => {
      if (!res.writableEnded) {
        abandoned++
        hung.delete(res)
        notify()
      }
      done()
    })
    // The body is drained so that a reply never races a request still being uploaded.
    req.resume()

    const reply = queue.shift() ?? fallback
    notify()
    if (reply === 'hang') {
      hung.add(res)
      return
    }
    if (reply === 'reset') {
      req.socket.destroy()
      return
    }
    answer(res, reply)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    arrivals,
    get inFlight() {
      return inFlight
    },
    get peakInFlight() {
      return peakInFlight
    },
    script: (...replies) => {
      queue.push(...replies)
    },
    setDefault: reply => {
      fallback = reply
    },
    arrived: count =>
      new Promise(resolve => {
        waiters.push({ count, kind: 'arrived', resolve })
        notify()
      }),
    abandoned: count =>
      new Promise(resolve => {
        waiters.push({ count, kind: 'abandoned', resolve })
        notify()
      }),
    releaseHung: (reply = { status: 200, body: { ok: true } }) => {
      if (reply === 'hang' || reply === 'reset') {
        throw new Error('releaseHung takes a status reply')
      }
      for (const res of [...hung]) {
        hung.delete(res)
        answer(res, reply)
      }
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const res of hung) {
          res.destroy()
        }
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
