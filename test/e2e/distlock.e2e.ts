import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { CaffeineIoC } from '@caffeinejs/di'
import {
  CaffeineDistLock,
  DEFAULT_DIST_LOCK_OPTIONS,
  ErrLockNotAcquired,
  distlock,
  kDistLock,
  kDistLockBackend,
  type Lock,
} from '@caffeinejs/distlock'
import { RedisLockBackend } from '@caffeinejs/distlock/backend/redis'
import { createApplication } from '@caffeinejs/std'
import { newNoopLogger } from '@caffeinejs/std/logger'
import { createClient } from '@redis/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { reachable } from './internal/redis/index.js'

// Every server the suite runs against. Adding a server is adding a row; the cases below run once per row.
const SERVERS = [
  { name: 'Redis', url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' },
  { name: 'Valkey', url: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6380' },
]

// Probed once, up front, so a row whose server is down skips on its own and the others still run.
const targets = await Promise.all(SERVERS.map(async server => ({ ...server, up: await reachable(server.url) })))

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

function newLock(client: Client): CaffeineDistLock {
  return new CaffeineDistLock(new RedisLockBackend(client), DEFAULT_DIST_LOCK_OPTIONS, newNoopLogger())
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

        const app = createApplication({ container }).with(distlock(d => d.backend(kDistLockBackend)))
        await app.ready()

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
                { wait: '30s', retryDelay: 5 },
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
          Array.from({ length: CLIENTS * 4 }, (_, i) => locks[i % CLIENTS].tryAcquire(k, { ttl: '5s' })),
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

        const wave = () => Promise.all(locks.flatMap(lock => [1, 2, 3].map(() => lock.once(k, action, { ttl: '10s' }))))

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
              const held = await lock.acquire(k, { wait: '3s', ttl: '10s', retryDelay: 20 })
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
              { wait: '30s', retryDelay: 5 },
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
  })
})
