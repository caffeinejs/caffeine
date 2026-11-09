import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * What a fake DSP does with one request: answer with a status and an optional JSON body, answer 200 with a body that
 * is not JSON, hold the request until the test releases it, or reset the connection.
 */
export type Reply = { readonly status: number; readonly body?: unknown } | 'malformed' | 'hang' | 'reset'

/** One request a fake DSP received. */
export interface Arrival {
  readonly path: string
  readonly body: unknown
}

/** A DSP on a real socket that answers as the test scripts it, and records what reached it. */
export interface FakeDSP {
  readonly origin: string
  /** Every request, `/bid` and `/win` alike, in arrival order. */
  readonly arrivals: readonly Arrival[]
  /** The most `/bid` requests it held at once. */
  readonly peakInFlight: number
  /** Queues replies for the next requests to `path`, in order; the default answers once they are spent. */
  script(path: '/bid' | '/win', ...replies: Reply[]): void
  /** What `path` answers once its script is spent. */
  setDefault(path: '/bid' | '/win', reply: Reply): void
  /** The requests to `path` so far. */
  count(path: '/bid' | '/win'): number
  /** Resolves once `count` requests in all reached `path`. */
  arrived(path: '/bid' | '/win', count: number): Promise<void>
  /** Resolves once the client closed `count` requests in all before they were answered. */
  abandoned(count: number): Promise<void>
  /** Answers every held request with `reply`. */
  release(reply: Reply): void
  close(): Promise<void>
}

/** A bid of `price` USD CPM, for the auction the request names. */
export function bid(price: number): Reply {
  return { status: 200, body: { price, adm: `<img src="https://ads.test/${price}.png">` } }
}

export const NO_BID: Reply = { status: 204 }

export async function startDSP(): Promise<FakeDSP> {
  const queues = { '/bid': [] as Reply[], '/win': [] as Reply[] }
  const defaults: Record<'/bid' | '/win', Reply> = { '/bid': NO_BID, '/win': { status: 200 } }
  const arrivals: Arrival[] = []
  const held = new Set<ServerResponse>()
  const waiters: Array<{ reached: () => boolean; resolve: () => void }> = []
  let inFlight = 0
  let peakInFlight = 0
  let abandoned = 0

  const notify = (): void => {
    for (const waiter of [...waiters]) {
      if (waiter.reached()) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }
  const waitFor = (reached: () => boolean): Promise<void> =>
    new Promise(resolve => {
      waiters.push({ reached, resolve })
      notify()
    })
  const count = (path: string): number => arrivals.filter(arrival => arrival.path === path).length

  const answer = (res: ServerResponse, reply: Reply): void => {
    if (res.writableEnded || res.destroyed) {
      return
    }
    if (reply === 'hang') {
      held.add(res)
      return
    }
    if (reply === 'reset') {
      res.socket?.destroy()
      return
    }
    if (reply === 'malformed') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"price": 1.5, "adm": ')
      return
    }
    if (reply.body === undefined) {
      res.writeHead(reply.status)
      res.end()
      return
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const path = req.url === '/win' ? '/win' : '/bid'
      const text = Buffer.concat(chunks).toString()
      arrivals.push({ path, body: text === '' ? undefined : JSON.parse(text) })

      if (path === '/bid') {
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
      }
      let settled = false
      const done = (): void => {
        if (!settled && path === '/bid') {
          inFlight--
        }
        settled = true
      }
      res.on('finish', done)
      res.on('close', () => {
        if (!res.writableEnded) {
          abandoned++
          held.delete(res)
        }
        done()
        notify()
      })

      notify()
      answer(res, queues[path].shift() ?? defaults[path])
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${port}`,
    arrivals,
    get peakInFlight() {
      return peakInFlight
    },
    script: (path, ...replies) => {
      queues[path].push(...replies)
    },
    setDefault: (path, reply) => {
      defaults[path] = reply
    },
    count,
    arrived: (path, n) => waitFor(() => count(path) >= n),
    abandoned: n => waitFor(() => abandoned >= n),
    release: reply => {
      for (const res of [...held]) {
        held.delete(res)
        answer(res, reply)
      }
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const res of held) {
          res.destroy()
        }
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
