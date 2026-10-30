import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** What the provider keeps for one idempotency key. */
export interface LedgerEntry {
  readonly key: string
  readonly amount: number
  readonly card: string
  readonly status: 'charged' | 'declined'
  readonly chargeId: string | undefined
}

/** What the next new key does instead of being charged normally. */
export type Fault =
  | { readonly kind: 'fail'; readonly status: number }
  | { readonly kind: 'chargeThenHang' }
  | { readonly kind: 'chargeThenDelay'; readonly delay: number }

/**
 * A payment provider on a real socket that deduplicates by `Idempotency-Key`, as real providers do.
 *
 * - `POST /charges`: a new key is charged and answered 201, or 402 for a card named `declined`. The same key and body
 *   again answers what the first one did; the same key while the first is still being processed answers 409
 *   `in_progress`; the same key with another body answers 422.
 * - `GET /charges/:key`: what the key ended as, or 404.
 * - More than `quota` new requests in any second answer 429.
 *
 * Every charge lands in `ledger`. `requests` counts every request a key reached the provider with.
 */
export interface PaymentProvider {
  readonly port: number
  readonly ledger: ReadonlyMap<string, LedgerEntry>
  readonly requests: ReadonlyMap<string, number>
  readonly peakInFlight: number
  readonly tooManyRequests: number
  /** Faults for the next new keys, in order. */
  fault(...faults: Fault[]): void
  /** Answers every reply `chargeThenHang` held back. */
  releaseHeld(): void
  /** Resolves when `count` charges in all are in the ledger. */
  charged(count: number): Promise<void>
  close(): Promise<void>
}

interface Pending {
  readonly body: string
  readonly settled: Promise<void>
}

export async function startPaymentProvider(
  options: { quota?: number; processing?: number } = {},
): Promise<PaymentProvider> {
  const quota = options.quota ?? Number.POSITIVE_INFINITY
  const processing = options.processing ?? 0
  const ledger = new Map<string, LedgerEntry>()
  const bodies = new Map<string, string>()
  const pending = new Map<string, Pending>()
  const requests = new Map<string, number>()
  const faults: Fault[] = []
  const held = new Set<() => void>()
  const waiters: Array<{ count: number; resolve: () => void }> = []
  const recent: number[] = []
  let inFlight = 0
  let peakInFlight = 0
  let tooManyRequests = 0
  let charges = 0

  const notify = (): void => {
    const count = [...ledger.values()].filter(entry => entry.status === 'charged').length
    for (const waiter of [...waiters]) {
      if (count >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    if (!res.writableEnded && !res.destroyed) {
      // Keep-alive stays on, unlike the scripted upstream: with `connection: close`, a reply the proxy holds reaches
      // the client as a closed connection rather than as silence, and a lost answer would no longer look like one.
      // Every client reaches this server through the proxy, whose close drops its connections, so none outlives a test.
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
  }

  const answer = (res: ServerResponse, entry: LedgerEntry): void => {
    send(res, entry.status === 'charged' ? 201 : 402, {
      status: entry.status,
      key: entry.key,
      chargeId: entry.chargeId,
    })
  }

  const read = (req: IncomingMessage): Promise<string> =>
    new Promise(resolve => {
      let text = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => (text += chunk))
      req.on('end', () => resolve(text))
    })

  const server = createServer(async (req, res) => {
    inFlight++
    peakInFlight = Math.max(peakInFlight, inFlight)
    res.on('close', () => inFlight--)
    const text = await read(req)

    if (req.method === 'GET' && req.url?.startsWith('/charges/')) {
      const entry = ledger.get(decodeURIComponent(req.url.slice('/charges/'.length)))
      return entry === undefined ? send(res, 404, { status: 'unknown' }) : answer(res, entry)
    }

    const key = String(req.headers['idempotency-key'] ?? '')
    requests.set(key, (requests.get(key) ?? 0) + 1)

    const done = ledger.get(key)
    if (done !== undefined) {
      return bodies.get(key) === text ? answer(res, done) : send(res, 422, { error: 'key_reused' })
    }
    const inProgress = pending.get(key)
    if (inProgress !== undefined) {
      return inProgress.body === text
        ? send(res, 409, { error: 'in_progress' })
        : send(res, 422, { error: 'key_reused' })
    }

    const now = performance.now()
    while (recent.length > 0 && recent[0]! <= now - 1_000) {
      recent.shift()
    }
    if (recent.length >= quota) {
      tooManyRequests++
      return send(res, 429, { error: 'quota' })
    }
    recent.push(now)

    const fault = faults.shift()
    if (fault?.kind === 'fail') {
      return send(res, fault.status, { error: 'unavailable' })
    }

    const { amount, card } = JSON.parse(text) as { amount: number; card: string }
    let finish!: () => void
    pending.set(key, { body: text, settled: new Promise(resolve => (finish = resolve)) })
    if (processing > 0) {
      await new Promise(resolve => setTimeout(resolve, processing))
    }
    const entry: LedgerEntry =
      card === 'declined'
        ? { key, amount, card, status: 'declined', chargeId: undefined }
        : { key, amount, card, status: 'charged', chargeId: `ch_${++charges}` }
    ledger.set(key, entry)
    bodies.set(key, text)
    pending.delete(key)
    finish()
    notify()

    if (fault?.kind === 'chargeThenHang') {
      held.add(() => answer(res, entry))
      return
    }
    if (fault?.kind === 'chargeThenDelay') {
      setTimeout(() => answer(res, entry), fault.delay)
      return
    }
    answer(res, entry)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    port: (server.address() as AddressInfo).port,
    ledger,
    requests,
    get peakInFlight() {
      return peakInFlight
    },
    get tooManyRequests() {
      return tooManyRequests
    },
    fault: (...next) => {
      faults.push(...next)
    },
    releaseHeld: () => {
      for (const reply of [...held]) {
        held.delete(reply)
        reply()
      }
    },
    charged: count =>
      new Promise(resolve => {
        waiters.push({ count, resolve })
        notify()
      }),
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
