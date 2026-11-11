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
  type DistLockOptions,
  type Lock,
} from '@caffeinejs/distlock'
import { RedisLockBackend, type RedisLockClient } from '@caffeinejs/distlock/backend/redis'
import type { AcquireOutcome, LostMessage } from '@caffeinejs/distlock/observability'
import { instrumentDistLock } from '@caffeinejs/distlock/observability/otel'
import { backendContractContext, lockBackendContract } from '@caffeinejs/distlock/testing'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { createClient, createCluster, SocketClosedUnexpectedlyError } from '@redis/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { startWorkers, type Worker } from './internal/distlock/cluster.js'
import { resourceKeys } from './internal/distlock/fenced_resource.js'
import { relayedClient, type RelayedClient } from './internal/distlock/outage.js'
import type { WorkerReply } from './internal/distlock/worker.js'
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

function newLock(client: RedisLockClient, options: Partial<DistLockOptions> = {}): CaffeineDistLock {
  return new CaffeineDistLock(
    new RedisLockBackend(client),
    { ...DEFAULT_DIST_LOCK_OPTIONS, ...options },
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
      // Leases lapse on the server's clock, which no test can move: the contract waits them out.
      it.each(lockBackendContract)('conforms to the backend contract: $name', async c => {
        const ctx = backendContractContext(new RedisLockBackend(clients[0]), {
          elapse: ms => sleep(ms),
          prefix: key('contract:'),
        })
        await c.run(ctx)
      })

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
              // The default backoff: every waiter still gets through inside the budget.
              { wait: 30 * Second },
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

    describe('electing a leader across processes', () => {
      let workers: Worker[] = []

      beforeEach(async () => {
        workers = await startWorkers(3, url)
      })

      afterEach(async () => {
        await Promise.all(workers.map(worker => worker.close()))
      })

      // Polls every live worker until exactly one leads, and returns its index.
      async function leaderAmong(k: string, live: Worker[], timeout: number): Promise<number> {
        let leader = -1
        await waitFor(async () => {
          const replies = await Promise.all(live.map(worker => worker.request({ op: 'leading', key: k })))
          const leading = replies.flatMap((reply, i) => (reply.leader === true ? [i] : []))
          leader = leading.length === 1 ? leading[0] : -1
          return leader !== -1
        }, timeout)
        return leader
      }

      it("elects one leader among three processes, and another within one backoff pause of the dead leader's lease lapsing", async () => {
        const k = key('elect')
        const ttl = 1 * Second
        for (const worker of workers) {
          await worker.request({ op: 'campaign', key: k, ttl })
        }

        const first = await leaderAmong(k, workers, 5 * Second)
        const elected = await Promise.all(workers.map(worker => worker.request({ op: 'leading', key: k })))
        expect(elected.map(reply => reply.elected ?? 0).reduce((a, b) => a + b)).toBe(1)

        await workers[first].kill()
        const killed = performance.now()
        const survivors = workers.filter((_, i) => i !== first)

        await leaderAmong(k, survivors, ttl + 1 * Second + 1 * Second)
        // The lease lapses, then one backoff pause at most (capped at the default maxRetryDelay).
        expect(performance.now() - killed).toBeLessThan(ttl + DEFAULT_DIST_LOCK_OPTIONS.maxRetryDelay + 500)
        const after = await Promise.all(survivors.map(worker => worker.request({ op: 'leading', key: k })))
        expect(after.map(reply => reply.elected ?? 0).reduce((a, b) => a + b)).toBe(1)
      })

      it('steps down on close so a follower is elected within 1 s', async () => {
        const k = key('elect-step')
        for (const worker of workers) {
          await worker.request({ op: 'campaign', key: k, ttl: 30 * Second })
        }
        const first = await leaderAmong(k, workers, 5 * Second)

        await workers[first].close()
        const closed = performance.now()

        await leaderAmong(
          k,
          workers.filter((_, i) => i !== first),
          1 * Second,
        )
        expect(performance.now() - closed).toBeLessThan(1 * Second)
      })
    })

    // A fencing token is what a resource uses to turn away a holder whose lease lapsed, so it only protects anything
    // while every later acquisition of a key carries a greater one, whichever client takes it.
    describe('fencing tokens', () => {
      const ACQUISITIONS = 200

      it(`issues strictly increasing fencing tokens to ${ACQUISITIONS} acquisitions of one key spread over every client`, async () => {
        const k = key('fence-mono')
        const tokens: number[] = []

        await Promise.all(
          locks.map(async (lock, client) => {
            for (let round = client; round < ACQUISITIONS; round += CLIENTS) {
              // Recorded inside the section, so the array is in acquisition order.
              await lock.withLock(k, held => void tokens.push(held.fencingToken), { wait: 30 * Second, retryDelay: 5 })
            }
          }),
        )

        expect(tokens).toHaveLength(ACQUISITIONS)
        for (let i = 1; i < tokens.length; i++) {
          expect(tokens[i]).toBeGreaterThan(tokens[i - 1])
        }
      })

      it('issues a greater token after the fence key was deleted', async () => {
        const k = key('fence-deleted')
        const first = await locks[0].acquire(k)
        await first.release()

        expect(await admin.del(`{${k}}:fence`)).toBe(1)
        const second = await locks[1].acquire(k)
        await second.release()

        expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
      })

      describe('across processes', () => {
        let workers: Worker[] = []

        beforeEach(async () => {
          workers = await startWorkers(2, url)
        })

        afterEach(async () => {
          await Promise.all(workers.map(worker => worker.close()))
        })

        it('rejects a write from a holder that resumed after its lease was taken over', async () => {
          const [a, b] = workers
          const k = key('fence-stale')
          const ttl = 500 * Millisecond
          const { value } = resourceKeys(k)

          const heldByA = await a.request({ op: 'tryAcquire', key: k, ttl, renew: false })
          expect(heldByA.acquired).toBe(true)
          expect((await a.request({ op: 'write', key: k, value: 'a1' })).accepted).toBe(true)

          a.pause()
          let heldByB: WorkerReply = { id: 0 }
          await waitFor(async () => {
            heldByB = await b.request({ op: 'tryAcquire', key: k, ttl: 10 * Second, renew: false })
            return heldByB.acquired === true
          }, 5 * Second)
          expect((await b.request({ op: 'write', key: k, value: 'b1' })).accepted).toBe(true)
          a.resume()

          expect((await a.request({ op: 'write', key: k, value: 'a2' })).accepted).toBe(false)
          expect(await admin.get(value)).toBe('b1')
          expect(heldByB.fencingToken).toBeGreaterThan(heldByA.fencingToken!)
          expect(await a.request({ op: 'status', key: k })).toMatchObject({
            lost: true,
            signalReason: { code: 'ERR_LOCK_LOST', reason: 'expired' },
          })
          await b.request({ op: 'release', key: k })
        })

        it("keeps a renewing holder's writes accepted across a pause shorter than its lease", async () => {
          const [a, b] = workers
          const k = key('fence-renewing')
          // A pause far shorter than the lease, so a busy machine cannot stretch it past the lease.
          const ttl = 10 * Second
          const pause = 2 * Second

          expect((await a.request({ op: 'tryAcquire', key: k, ttl, renew: true })).acquired).toBe(true)
          expect((await a.request({ op: 'write', key: k, value: 'a1' })).accepted).toBe(true)

          a.pause()
          // Probed through the pause: the key the paused holder renewed before stopping is still its own.
          const deadline = performance.now() + pause
          while (performance.now() < deadline) {
            expect((await b.request({ op: 'tryAcquire', key: k, ttl, renew: false })).acquired).toBe(false)
            await sleep(50)
          }
          a.resume()

          expect((await a.request({ op: 'write', key: k, value: 'a2' })).accepted).toBe(true)
          expect(await a.request({ op: 'status', key: k })).toMatchObject({ lost: false })
          await a.request({ op: 'release', key: k })
        })
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

    describe('on a rolling restart', () => {
      const REPLICAS = 3
      let replicas: CaffeineDistLock[]

      beforeEach(() => {
        replicas = clients.slice(0, REPLICAS).map(client => newLock(client, { drainTimeout: 200 * Millisecond }))
      })

      afterEach(async () => {
        await Promise.all(replicas.map(replica => replica.onDestroy()))
      })

      // Measured from close resolving: the next replica must not wait out a 30 s lease the closed one let go of.
      async function handedOver(keys: string[]): Promise<void> {
        await replicas[0].onDestroy()

        const started = performance.now()
        for (const k of keys) {
          const next = await replicas[1].acquire(k, { ttl: 10 * Second, wait: 1 * Second })
          await next.release()
        }
        expect(performance.now() - started).toBeLessThan(1 * Second)
      }

      it('hands keys over within 1 s on a rolling restart when holders release on abort', async () => {
        const keys = replicas.map((_, i) => key(`roll:${i}`))

        for (const [i, replica] of replicas.entries()) {
          const held = await replica.acquire(keys[i], { ttl: 30 * Second, renew: true })
          held.signal.addEventListener('abort', () => void held.release())
        }

        await handedOver([keys[0]])
        // The replicas still running keep theirs.
        expect(await replicas[1].tryAcquire(keys[2])).toBeUndefined()
      })

      it('hands keys over within 1 s on a rolling restart when withLock sections observe their signal', async () => {
        const keys = replicas.map((_, i) => key(`roll-section:${i}`))
        const entered = replicas.map(() => Promise.withResolvers<void>())
        const sections = replicas.map((replica, i) =>
          replica
            .withLock(
              keys[i],
              l => {
                entered[i].resolve()
                return new Promise((_, reject) => l.signal.addEventListener('abort', () => reject(l.signal.reason)))
              },
              { ttl: 30 * Second },
            )
            .catch((error: unknown) => error),
        )
        await Promise.all(entered.map(e => e.promise))

        await handedOver([keys[0]])

        const ended = await sections[0]
        expect(ended).toBeInstanceOf(ErrLockLost)
        expect((ended as ErrLockLost).reason).toBe('shutdown')
      })
    })

    // The relay holds replies back, drops connections or refuses new ones, so the server itself is never touched.
    describe('through an outage', () => {
      const STORE_TIMEOUT = 300 * Millisecond
      const DRAIN_TIMEOUT = 300 * Millisecond
      let relayed: RelayedClient
      let lock: CaffeineDistLock

      beforeEach(async () => {
        relayed = await relayedClient(url)
        lock = newLock(relayed.client, { storeTimeout: STORE_TIMEOUT, drainTimeout: DRAIN_TIMEOUT })
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

        // The SET reached the server. Only its reply is held back.
        expect(await admin.exists(k)).toBe(1)
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

      it('does not let close hang on a server that stopped answering', async () => {
        const held = await lock.acquire(key('hang-close'), { ttl: 10 * Second, renew: true })
        held.signal.addEventListener('abort', () => void held.release().catch(() => undefined))
        const entered = Promise.withResolvers<void>()
        const section = lock
          .withLock(
            key('hang-close-section'),
            l => {
              entered.resolve()
              return new Promise((_, reject) => l.signal.addEventListener('abort', () => reject(l.signal.reason)))
            },
            { ttl: 10 * Second },
          )
          .catch(() => undefined)
        await entered.promise

        relayed.proxy.hold()
        const started = performance.now()
        await lock.onDestroy()

        expect(performance.now() - started).toBeLessThan(DRAIN_TIMEOUT + 2 * STORE_TIMEOUT + 500)
        await section
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
        // A dropped socket can surface either Redis's close error or a TLS reset. Both are immediate backend errors.
        const error = await lock
          .acquire(k, { ttl: 10 * Second, wait: 500 * Millisecond })
          .catch((failure: unknown) => failure)
        expect(
          error instanceof SocketClosedUnexpectedlyError ||
            (error instanceof Error && 'code' in error && error.code === 'ECONNRESET'),
        ).toBe(true)
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

// One-node clusters still answer CROSSSLOT, so they prove the script that numbers a lease names keys of one slot.
const CLUSTERS = [
  { name: 'Redis cluster', url: process.env.REDIS_CLUSTER_URL ?? 'redis://127.0.0.1:6381' },
  { name: 'Valkey cluster', url: process.env.VALKEY_CLUSTER_URL ?? 'redis://127.0.0.1:6382' },
]

const clusterTargets = await Promise.all(
  CLUSTERS.map(async server => ({ ...server, up: required(server.name, await reachable(server.url)) })),
)

describe.each(clusterTargets)('distlock over $name', ({ name, url, up }) => {
  it.skipIf(!up)("keeps fencing tokens in the lock key's slot on a one-node cluster, hash tag or not", async () => {
    const cluster = createCluster({ rootNodes: [{ url }] })
    await cluster.connect()
    const lock = newLock(cluster)
    // A key with a hash tag of its own keeps it: wrapped again, its fence key would hash elsewhere.
    const keys = [`caffeine:distlock:e2e:${RUN}:${name}:fence-cluster`, `{${RUN}}:${name}:fence-cluster-tagged`]

    try {
      for (const k of keys) {
        const first = await lock.acquire(k)
        await first.release()
        const second = await lock.acquire(k)
        await second.release()

        expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
      }
    } finally {
      await lock.onDestroy()
      await cluster.close()
    }
  })
})
