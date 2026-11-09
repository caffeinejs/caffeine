import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { createApplication } from '@caffeinejs/application'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineIoC } from '@caffeinejs/di'
import {
  CaffeineDistLock,
  DEFAULT_DIST_LOCK_OPTIONS,
  ErrLockBackendTimeout,
  ErrLockNotAcquired,
  DistributedLock,
  kDistLock,
  kDistLockBackend,
  ErrLockLost,
  type Lock,
} from '@caffeinejs/distlock'
import { RedisLockBackend, type RedisLockClient } from '@caffeinejs/distlock/backend/redis'
import type { AcquireOutcome, LostMessage } from '@caffeinejs/distlock/observability'
import { instrumentDistLock } from '@caffeinejs/distlock/observability/otel'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { createClient, SocketClosedUnexpectedlyError } from '@redis/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { relayedClient, type RelayedClient } from './internal/distlock/outage.js'
import { reachable } from './internal/redis/index.js'
import { required } from './internal/strict.js'

// Every server the suite runs against. Adding a server is adding a row; the cases below run once per row.
const SERVERS = [
  { name: 'Redis', url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' },
  { name: 'Valkey', url: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6380' },
]

// Probed once, up front, so a row whose server is down skips on its own and the others still run.
const targets = await Promise.all(
  SERVERS.map(async server => ({ ...server, up: required(server.name, await reachable(server.url)) })),
)

const newClient = (url: string) => createClient({ url })
type Client = ReturnType<typeof newClient>

// Every client is its own connection with its own lock service, so contention goes through the server and never
// through state one process shares.
const CLIENTS = 50
const ROUNDS = 20

// Keys are unique per run, so a rerun never meets a key a previous one left behind, and nothing is flushed.
const RUN = randomUUID()

async function connected(url: string): Promise<Client> {
  const client = newClient(url)
  await client.connect()
  return client
}

function newLock(client: RedisLockClient, storeTimeout = DEFAULT_DIST_LOCK_OPTIONS.storeTimeout): CaffeineDistLock {
  return new CaffeineDistLock(
    new RedisLockBackend(client),
    { ...DEFAULT_DIST_LOCK_OPTIONS, storeTimeout },
    newNoopLogger(),
  )
}

// Polls in real time until `probe` holds, or fails after `timeout`.
async function waitFor(probe: () => Promise<boolean> | boolean, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout
  while (!(await probe())) {
    if (performance.now() > deadline) {
      throw new Error(`condition not met within ${timeout}ms`)
    }
    await sleep(20)
  }
}

describe.each(targets)('distlock over $name', ({ name, url, up }) => {
  const key = (k: string) => `caffeine:distlock:e2e:${RUN}:${name}:${k}`

  describe.skipIf(!up)(url, () => {
    let admin: Client
    const clients: Client[] = []
    const locks: CaffeineDistLock[] = []

    beforeAll(async () => {
      admin = await connected(url)
      for (let i = 0; i < CLIENTS; i++) {
        const client = await connected(url)
        clients.push(client)
        locks.push(newLock(client))
      }
    })

    afterAll(async () => {
      await Promise.all(locks.map(lock => lock.onDestroy()))
      await Promise.all([admin, ...clients].map(client => client?.close()))
    })

    describe('RedisLockBackend', () => {
      it('turns a second acquisition away until the server expires the key', async () => {
        const backend = new RedisLockBackend(clients[0])
        const k = key('expiry')

        expect(await backend.tryAcquire(k, 200)).toBeDefined()
        expect(await backend.tryAcquire(k, 200)).toBeUndefined()

        await sleep(300)

        expect(await backend.tryAcquire(k, 200)).toBeDefined()
      })

      it('never reports a lease outliving the key the server holds', async () => {
        const backend = new RedisLockBackend(clients[0])
        const k = key('expires-at')

        const lease = await backend.tryAcquire(k, 5_000)
        const serverExpiry = Date.now() + (await admin.pTTL(k))

        // pTTL truncates to whole milliseconds, hence the slack.
        expect(lease!.expiresAt).toBeLessThanOrEqual(serverExpiry + 2)
      })

      it('leaves a newer holder alone when a stale lease releases', async () => {
        const backend = new RedisLockBackend(clients[0])
        const k = key('stale-release')

        const stale = await backend.tryAcquire(k, 100)
        await sleep(150)
        const current = await backend.tryAcquire(k, 5_000)

        await backend.release(stale!)

        expect(await admin.get(k)).toBe(current!.token)
      })

      it('does not bring a released key back when extending it', async () => {
        const backend = new RedisLockBackend(clients[0])
        const k = key('extend-released')

        const lease = await backend.tryAcquire(k, 5_000)
        await backend.release(lease!)

        expect(await backend.extend(lease!, 5_000)).toBeUndefined()
        expect(await admin.exists(k)).toBe(0)
      })

      it('sets the remaining validity rather than adding to it', async () => {
        const backend = new RedisLockBackend(clients[0])
        const k = key('extend-sets')

        const lease = await backend.tryAcquire(k, 10_000)

        expect(await backend.extend(lease!, 500)).toBeDefined()
        expect(await admin.pTTL(k)).toBeLessThanOrEqual(500)

        expect(await backend.extend(lease!, 20_000)).toBeDefined()
        expect(await admin.pTTL(k)).toBeGreaterThan(10_000)
      })

      it('runs behind the feature when bound under a key', async () => {
        const container = new CaffeineIoC({ decorators: false })
        container.bind(kDistLockBackend, t => t.toValue(new RedisLockBackend(clients[0])))

        const app = createApplication({ container }).install(DistributedLock(d => d.backend(kDistLockBackend)))
        await app.bootstrap()

        try {
          const k = key('feature')
          const lock = await app.container.get(kDistLock).tryAcquire(k)

          expect(await admin.get(k)).toBe(lock!.token)

          await lock!.release()

          expect(await admin.exists(k)).toBe(0)
        } finally {
          await app.close()
        }
      })
    })

    describe('under concurrent clients', () => {
      it('keeps a read-modify-write on the server free of lost updates', async () => {
        const lockKey = key('rmw-lock')
        const counterKey = key('rmw-counter')
        let inside = 0
        let maxInside = 0

        // The pause between GET and SET makes a lost update near-certain the moment two sections overlap.
        await Promise.all(
          locks.map(async (lock, i) => {
            for (let round = 0; round < ROUNDS; round++) {
              await lock.withLock(
                lockKey,
                async () => {
                  inside++
                  maxInside = Math.max(maxInside, inside)

                  const n = Number((await clients[i].get(counterKey)) ?? 0)
                  await sleep(Math.random() * 5)
                  await clients[i].set(counterKey, String(n + 1))

                  inside--
                },
                { wait: 30 * Second, retryDelay: 5 },
              )
            }
          }),
        )

        expect(maxInside).toBe(1)
        expect(Number(await admin.get(counterKey))).toBe(CLIENTS * ROUNDS)
      }, 120_000)

      it('hands a storm of simultaneous attempts exactly one lease', async () => {
        const k = key('storm')

        const leases = await Promise.all(
          Array.from({ length: CLIENTS * 4 }, (_, i) => locks[i % CLIENTS].tryAcquire(k, { ttl: 5 * Second })),
        )
        const winners = leases.filter(lease => lease !== undefined)

        expect(winners).toHaveLength(1)
        expect(await admin.get(k)).toBe(winners[0].token)

        await winners[0].release()
      })

      it('runs a once action a single time across every client, and not again inside the window', async () => {
        const k = key('once')
        let runs = 0
        const action = async () => {
          runs++
          await sleep(20)
        }

        const wave = () =>
          Promise.all(locks.flatMap(lock => [1, 2, 3].map(() => lock.once(k, action, { ttl: 10 * Second }))))

        const first = await wave()
        const second = await wave()

        expect(runs).toBe(1)
        expect(first.filter(r => r.executed)).toHaveLength(1)
        expect(second.filter(r => r.executed)).toHaveLength(0)
      })

      it('does not serialize clients holding unrelated keys', async () => {
        const held = await Promise.all(locks.map((lock, i) => lock.acquire(key(`own-${i}`), { wait: 0 })))

        await Promise.all(held.map(lock => lock.release()))
      })

      it('keeps a renewing holder in place past its lease while others poll', async () => {
        const k = key('renew')
        const holder = await locks[0].acquire(k, { ttl: 300, renew: true })
        const stolen: Lock[] = []
        const until = Date.now() + 900

        await Promise.all(
          locks.slice(1).map(async lock => {
            while (Date.now() < until) {
              const lease = await lock.tryAcquire(k, { ttl: 300 })
              if (lease !== undefined) {
                stolen.push(lease)
              }
              await sleep(20)
            }
          }),
        )

        expect(stolen).toHaveLength(0)
        expect(holder.lost).toBe(false)

        await holder.release()

        const next = await locks[1].tryAcquire(k)
        expect(next).toBeDefined()
        await next!.release()
      })

      it('recovers a key whose holder died without releasing, once its lease lapses', async () => {
        const k = key('crash')
        const doomed = await connected(url)
        const dead = await newLock(doomed).tryAcquire(k, { ttl: 500 })

        doomed.destroy()

        const won: Array<{ lock: Lock; at: number }> = []
        const failed: unknown[] = []

        await Promise.all(
          locks.map(async lock => {
            try {
              const held = await lock.acquire(k, { wait: 3 * Second, ttl: 10 * Second, retryDelay: 20 })
              won.push({ lock: held, at: Date.now() })
            } catch (error) {
              failed.push(error)
            }
          }),
        )

        expect(won).toHaveLength(1)
        expect(won[0].at).toBeGreaterThanOrEqual(dead!.expiresAt)
        expect(failed).toHaveLength(CLIENTS - 1)
        expect(failed.every(error => error instanceof ErrLockNotAcquired)).toBe(true)

        await won[0].lock.release()
      })

      it('lets every waiter through one at a time, with no two sections overlapping', async () => {
        const k = key('handover')
        const sections: Array<{ client: number; enter: number; exit: number }> = []

        await Promise.all(
          locks.map((lock, client) =>
            lock.withLock(
              k,
              async () => {
                const enter = performance.now()
                await sleep(10)
                sections.push({ client, enter, exit: performance.now() })
              },
              { wait: 30 * Second, retryDelay: 5 },
            ),
          ),
        )

        expect(sections.map(s => s.client).sort((a, b) => a - b)).toEqual([...Array(CLIENTS).keys()])

        const ordered = sections.toSorted((a, b) => a.enter - b.enter)
        for (let i = 1; i < ordered.length; i++) {
          expect(ordered[i].enter).toBeGreaterThanOrEqual(ordered[i - 1].exit)
        }
      })
    })

    // One row is enough: the instrumentation reads the core's channels, not the server.
    if (name === 'Redis') {
      describe('with OpenTelemetry', () => {
        it('records an acquire, withLock and release span per section, and one lost counter per lost lease', async () => {
          const spans = new InMemorySpanExporter()
          const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] })
          const reader = new PeriodicExportingMetricReader({
            exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
            exportIntervalMillis: 3_600_000,
          })
          const meterProvider = new MeterProvider({ readers: [reader] })
          const lock = locks[0]
          const stop = instrumentDistLock({ tracerProvider, meterProvider, service: lock })

          try {
            const sections = 3
            for (let i = 0; i < sections; i++) {
              await lock.withLock(key(`otel-${i}`), () => i)
            }

            const lapsing = await lock.acquire(key('otel-lost'), { ttl: 200 * Millisecond })
            await waitFor(() => lapsing.signal.aborted, 2 * Second)
            await lapsing.release()

            const names = spans.getFinishedSpans().map(span => span.name)
            expect(names.filter(n => n === 'distlock.withLock')).toHaveLength(sections)
            expect(names.filter(n => n === 'distlock.acquire')).toHaveLength(sections + 1)
            expect(names.filter(n => n === 'distlock.release')).toHaveLength(sections + 1)

            const { resourceMetrics } = await reader.collect()
            const lostPoints = resourceMetrics.scopeMetrics
              .flatMap(scope => scope.metrics)
              .filter(metric => metric.descriptor.name === 'distlock.lease.lost')
              .flatMap(metric => metric.dataPoints as Array<{ attributes: Record<string, unknown>; value: unknown }>)
            expect(lostPoints.map(point => [point.attributes['distlock.reason'], point.value])).toEqual([
              ['expired', 1],
            ])
          } finally {
            stop()
            await tracerProvider.shutdown()
            await meterProvider.shutdown()
          }
        })
      })
    }

    // The relay holds replies back, drops connections or refuses new ones, so the server itself is never touched.
    describe('through an outage', () => {
      const STORE_TIMEOUT = 300 * Millisecond
      let relayed: RelayedClient
      let lock: CaffeineDistLock

      beforeEach(async () => {
        relayed = await relayedClient(url)
        lock = newLock(relayed.client, STORE_TIMEOUT)
      })

      afterEach(async () => {
        relayed.proxy.release()
        relayed.proxy.accept()
        await lock.onDestroy()
        await relayed.close()
      })

      it('gives a try up after storeTimeout when the server stops answering, and resumes once it does', async () => {
        const k = key('hang')

        relayed.proxy.hold()
        const started = performance.now()
        const error = await lock.tryAcquire(k, { ttl: 10 * Second }).catch((e: unknown) => e)
        const elapsed = performance.now() - started

        expect(error).toBeInstanceOf(ErrLockBackendTimeout)
        expect(elapsed).toBeLessThan(STORE_TIMEOUT + 500)

        // The SET reached the server and its reply was only held back: the late lease is given back.
        relayed.proxy.release()
        await waitFor(async () => (await admin.exists(k)) === 0, 2 * Second)

        const next = await lock.acquire(k, { ttl: 10 * Second })
        expect(await admin.get(k)).toBe(next.token)
        await next.release()
      })

      it('does not let release hang on a server that stopped answering', async () => {
        const k = key('hang-release')

        const held = await lock.acquire(k, { ttl: 10 * Second })
        relayed.proxy.hold()
        const started = performance.now()
        await expect(held.release()).rejects.toBeInstanceOf(ErrLockBackendTimeout)
        expect(performance.now() - started).toBeLessThan(STORE_TIMEOUT + 500)
        relayed.proxy.release()

        const wk = key('hang-with-lock')
        const sectionStarted = performance.now()
        const result = await lock.withLock(
          wk,
          () => {
            relayed.proxy.hold()
            return 'done'
          },
          { ttl: 10 * Second },
        )

        expect(result).toBe('done')
        expect(performance.now() - sectionStarted).toBeLessThan(STORE_TIMEOUT + 500)
      })

      it('recovers renewal after the connection drops and the client reconnects', async () => {
        const k = key('drop')
        const ttl = 600 * Millisecond

        let renewals = 0
        lock.events.on('extend', ctx => {
          if (ctx.outcome === 'extended') {
            renewals++
          }
        })

        const holder = await lock.acquire(k, { ttl, renew: true })
        // Dropped right after a renewal landed, so none is on the wire when the connection goes.
        await waitFor(() => renewals === 1, 2 * Second)
        relayed.proxy.dropConnections()
        // Renewals land again only once the client reconnected; three of them carry the lease past twice its ttl.
        await waitFor(() => renewals === 4, 5 * Second)

        expect(holder.lost).toBe(false)
        expect(await admin.get(k)).toBe(holder.token)

        await holder.release()
      })

      it('loses a renewing lease when the server stops answering for longer than the lease, and says so once', async () => {
        const k = key('hang-renew')
        const lost: LostMessage[] = []
        lock.events.on('lost', message => lost.push(message))

        const holder = await lock.acquire(k, { ttl: 1 * Second, renew: true })
        relayed.proxy.hold()
        await waitFor(() => holder.signal.aborted, 3 * Second)

        expect(holder.signal.reason).toBeInstanceOf(ErrLockLost)
        expect((holder.signal.reason as ErrLockLost).reason).toBe('error')
        // Nothing marks "no second report": wait past the lease, when the deadline and any late renewal over the
        // real relay would have reported one.
        await sleep(1 * Second)

        relayed.proxy.release()
        await holder.release()

        expect(lost.map(message => message.leaseID)).toEqual([holder.leaseID])
        expect(await admin.get(k)).not.toBe(holder.token)
      })

      it('fails acquisition fast while the server refuses connections, and recovers', async () => {
        const k = key('refuse')
        const outcomes: Array<AcquireOutcome | undefined> = []
        lock.events.on('acquire', ctx => outcomes.push(ctx.outcome))

        relayed.proxy.refuse()
        relayed.proxy.dropConnections()

        const started = performance.now()
        // The client fails the command on the dropped socket, and a backend error that is not a timeout is not
        // retried.
        await expect(lock.acquire(k, { ttl: 10 * Second, wait: 500 * Millisecond })).rejects.toBeInstanceOf(
          SocketClosedUnexpectedlyError,
        )
        expect(performance.now() - started).toBeLessThan(500 + STORE_TIMEOUT + 500)
        expect(outcomes).toEqual(['error'])

        relayed.proxy.accept()

        // Commands queued while the client was offline go out once it reconnects; any lease they take is
        // given back, so the next acquire gets the key within its wait.
        const next = await lock.acquire(k, { ttl: 10 * Second, wait: 5 * Second })
        expect(await admin.get(k)).toBe(next.token)
        await next.release()
      })
    })
  })
})
