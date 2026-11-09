import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { newNoopLogger } from '@caffeinejs/application/logger'
import { CaffeineDistLock, DEFAULT_DIST_LOCK_OPTIONS, ErrLockLost } from '@caffeinejs/distlock'
import { PostgresLockBackend, postgresLockTableDDL } from '@caffeinejs/distlock/backend/postgres'
import { backendContractContext, lockBackendContract } from '@caffeinejs/distlock/testing'
import { Hour, Millisecond, Second } from '@caffeinejs/std/duration'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { reachable } from './internal/redis/index.js'
import { required } from './internal/strict.js'

const PG_URL = process.env.PG_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres'
const up = required('PostgreSQL', await reachable(PG_URL, 5432))

// Keys are unique per run, so a rerun never meets a row a previous one left behind, and nothing is truncated.
const RUN = randomUUID()
const key = (k: string) => `caffeine:distlock:e2e:${RUN}:${k}`

const CLIENTS = 20

function newLock(client: pg.Pool | pg.Client): CaffeineDistLock {
  return new CaffeineDistLock(new PostgresLockBackend(client), DEFAULT_DIST_LOCK_OPTIONS, newNoopLogger())
}

// Polls in real time until `probe` holds, or fails after `timeout`.
async function waitFor(probe: () => Promise<boolean>, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout
  while (!(await probe())) {
    if (performance.now() > deadline) {
      throw new Error(`condition not met within ${timeout}ms`)
    }
    await sleep(20)
  }
}

describe.skipIf(!up)('distlock over PostgreSQL', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: CLIENTS })
    await pool.query(postgresLockTableDDL())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    await pool?.end()
  })

  it.each(lockBackendContract)('conforms to the backend contract: $name', async c => {
    const ctx = backendContractContext(new PostgresLockBackend(pool), {
      elapse: ms => sleep(ms),
      prefix: key('contract:'),
    })
    await c.run(ctx)
  })

  it('issues strictly increasing fencing tokens to 200 acquisitions of one key spread over every client', async () => {
    const k = key('fence-mono')
    const locks = Array.from({ length: CLIENTS }, () => newLock(pool))
    const tokens: number[] = []

    // Pushed while the key is held, so the order of the array is the order of the acquisitions.
    await Promise.all(
      locks.map(async lock => {
        for (let round = 0; round < 200 / CLIENTS; round++) {
          await lock.withLock(k, held => void tokens.push(held.fencingToken), { wait: 30 * Second })
        }
      }),
    )

    expect(tokens).toHaveLength(200)
    expect(tokens.every((token, i) => i === 0 || token > tokens[i - 1])).toBe(true)
  })

  it('survives a pool of 20 connections contending for one key with no lost update', async () => {
    const k = key('rmw')
    const id = key('rmw-row')
    const rounds = 10
    await pool.query('CREATE TABLE IF NOT EXISTS distlock_rmw (id text PRIMARY KEY, n integer NOT NULL)')
    await pool.query('INSERT INTO distlock_rmw (id, n) VALUES ($1, 0)', [id])

    const locks = Array.from({ length: CLIENTS }, () => newLock(pool))
    await Promise.all(
      locks.map(async lock => {
        for (let round = 0; round < rounds; round++) {
          await lock.withLock(
            k,
            async () => {
              const { rows } = await pool.query<{ n: number }>('SELECT n FROM distlock_rmw WHERE id = $1', [id])
              // Widens the window a lost update needs.
              await sleep(1)
              await pool.query('UPDATE distlock_rmw SET n = $2 WHERE id = $1', [id, rows[0].n + 1])
            },
            { wait: 30 * Second },
          )
        }
      }),
    )

    const { rows } = await pool.query<{ n: number }>('SELECT n FROM distlock_rmw WHERE id = $1', [id])
    expect(rows[0].n).toBe(CLIENTS * rounds)
  })

  // A client whose clock runs ahead must not see a key free that the database still holds.
  it("expires by the database clock, not the client's", async () => {
    const backend = new PostgresLockBackend(pool)
    const k = key('clock')
    const held = await backend.tryAcquire(k, 10 * Second)
    expect(held).toBeDefined()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 1 * Hour)

    expect(await backend.tryAcquire(k, 10 * Second)).toBeUndefined()

    vi.useRealTimers()
    await backend.release(held!)
  })

  it("recovers a key whose holder's connection was killed", async () => {
    const doomed = new pg.Client({ connectionString: PG_URL })
    // The termination arrives as an error on the idle client.
    doomed.on('error', () => undefined)
    await doomed.connect()

    const k = key('kill')
    // Long enough that the key is still held when the check below runs on a busy machine.
    const ttl = 2 * Second
    const { rows } = await doomed.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    expect(await new PostgresLockBackend(doomed).tryAcquire(k, ttl)).toBeDefined()

    await pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid])

    // The row outlives the connection, as a lease should: the key is free once it lapses, and not before.
    const survivor = new PostgresLockBackend(pool)
    expect(await survivor.tryAcquire(k, 10 * Second)).toBeUndefined()
    await waitFor(async () => (await survivor.tryAcquire(k, 10 * Second)) !== undefined, ttl + 2 * Second)

    await doomed.end().catch(() => undefined)
  })

  // The clock floor alone would issue a lower token after the database clock stepped back; the stored fence of a
  // lapsed row is what keeps the next token above every one already handed out.
  it('issues the stored fence plus one when a lapsed row carries a fence ahead of the clock', async () => {
    const backend = new PostgresLockBackend(pool)
    const k = key('fence-ahead')
    const ahead = Date.now() * 1000 + 10 ** 12
    await pool.query(
      "INSERT INTO caffeine_locks (key, token, fence, expires_at) VALUES ($1, 'gone', $2, clock_timestamp() - interval '1 second')",
      [k, ahead],
    )

    const lease = await backend.tryAcquire(k, 10 * Second)

    expect(lease?.fencingToken).toBe(ahead + 1)
    await backend.release(lease!)
  })

  // The resource takes a write only under a fencing token at least as high as the last it accepted, so a holder
  // that resumes after its lease lapsed cannot overwrite the work of the one that took over.
  it('rejects a write from a holder that resumed after its lease was taken over', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS distlock_fenced (id text PRIMARY KEY, fence bigint NOT NULL, value text NOT NULL)',
    )
    const id = key('fenced-row')
    await pool.query('INSERT INTO distlock_fenced (id, fence, value) VALUES ($1, 0, $2)', [id, 'none'])
    const write = async (fence: number, value: string): Promise<boolean> => {
      const { rowCount } = await pool.query(
        'UPDATE distlock_fenced SET fence = $2, value = $3 WHERE id = $1 AND fence <= $2',
        [id, fence, value],
      )
      return rowCount === 1
    }

    const [a, b] = [newLock(pool), newLock(pool)]
    const k = key('fence-stale')
    const ttl = 300 * Millisecond

    const heldByA = await a.tryAcquire(k, { ttl })
    expect(await write(heldByA!.fencingToken, 'a')).toBe(true)

    // A pauses past its lease; B takes the key over.
    const heldByB = await b.acquire(k, { ttl: 10 * Second, wait: 5 * Second })
    expect(heldByB.fencingToken).toBeGreaterThan(heldByA!.fencingToken)
    expect(await write(heldByB.fencingToken, 'b')).toBe(true)

    expect(await write(heldByA!.fencingToken, 'a again')).toBe(false)
    // A was told: its signal carries the lapse.
    expect(heldByA!.lost).toBe(true)
    const reason: unknown = heldByA!.signal.reason
    expect(reason).toBeInstanceOf(ErrLockLost)
    expect(reason).toMatchObject({ code: 'ERR_LOCK_LOST', reason: 'expired' })

    const { rows } = await pool.query<{ value: string }>('SELECT value FROM distlock_fenced WHERE id = $1', [id])
    expect(rows[0].value).toBe('b')
    await heldByB.release()
  })
})
