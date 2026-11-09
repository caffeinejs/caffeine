import { Second } from '@caffeinejs/std/duration'
import { describe, expect, it } from 'vitest'

import type { LockLease } from '../../backend.js'
import { ErrDistLockConfiguration } from '../../errors.js'
import { PostgresLockBackend, postgresLockTableDDL, type PostgresLockClient } from './postgres.js'

interface Sent {
  text: string
  values: unknown[] | undefined
}

/** Records every statement, and answers each with the rows the test queued, or none. */
class StubClient implements PostgresLockClient {
  readonly sent: Sent[] = []
  readonly replies: Array<Array<Record<string, unknown>>> = []

  query<R extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
    this.sent.push({ text, values })
    return Promise.resolve({ rows: (this.replies.shift() ?? []) as R[] })
  }
}

const lease: LockLease = { key: 'orders', token: 't-1', fencingToken: 7, expiresAt: 0 }

describe('PostgresLockBackend', () => {
  // The interval is whole milliseconds rounded up, so a lease is never shorter on the database than asked for.
  it('acquires with one upsert that takes only a lapsed row, sending key, a fresh token and the ttl in milliseconds', async () => {
    const client = new StubClient()
    client.replies.push([{ fence: '1700000000000001' }])
    const before = Date.now()

    const got = await new PostgresLockBackend(client).tryAcquire('orders', 1.5)

    expect(client.sent).toHaveLength(1)
    const [{ text, values }] = client.sent
    expect(text).toContain('INSERT INTO "caffeine_locks" AS held')
    expect(text).toContain('ON CONFLICT (key) DO UPDATE')
    expect(text).toContain('WHERE held.expires_at <= clock_timestamp()')
    expect(text).toContain('GREATEST(held.fence + 1, EXCLUDED.fence)')
    expect(values).toEqual(['orders', got?.token, '2 milliseconds'])
    expect(got?.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(got?.key).toBe('orders')
    expect(got!.expiresAt - before).toBeGreaterThanOrEqual(2)
    expect(got!.expiresAt).toBeLessThanOrEqual(Date.now() + 2)
  })

  // `pg` hands `bigint` columns over as text; the core compares fencing tokens as numbers.
  it('reads the fencing token, which pg sends as text, as a number', async () => {
    const client = new StubClient()
    client.replies.push([{ fence: '1700000000000001' }])

    const got = await new PostgresLockBackend(client).tryAcquire('orders', 1 * Second)

    expect(got?.fencingToken).toBe(1_700_000_000_000_001)
  })

  it('reports a held key as no lease when the upsert returns no row', async () => {
    const client = new StubClient()

    expect(await new PostgresLockBackend(client).tryAcquire('orders', 1 * Second)).toBeUndefined()
  })

  // Extend is compare-and-expire: it must never write a row back, or a released key would be held again.
  it('extends with an update guarded by the token and a lease still good, keeping the fencing token', async () => {
    const client = new StubClient()
    client.replies.push([{ fence: '7' }])

    const got = await new PostgresLockBackend(client).extend(lease, 3 * Second)

    const [{ text, values }] = client.sent
    expect(text).toMatch(/^UPDATE "caffeine_locks"/)
    expect(text).toContain('WHERE key = $1 AND token = $2 AND expires_at > clock_timestamp()')
    expect(values).toEqual(['orders', 't-1', '3000 milliseconds'])
    expect(got).toEqual({ ...lease, expiresAt: got!.expiresAt })
    expect(got!.expiresAt).toBeGreaterThan(Date.now())
  })

  it('reports a lost lease as undefined when the update matches no row', async () => {
    const client = new StubClient()

    expect(await new PostgresLockBackend(client).extend(lease, 1 * Second)).toBeUndefined()
  })

  it('releases with a delete guarded by the token', async () => {
    const client = new StubClient()

    await new PostgresLockBackend(client).release(lease)

    expect(client.sent).toEqual([
      { text: 'DELETE FROM "caffeine_locks" WHERE key = $1 AND token = $2', values: ['orders', 't-1'] },
    ])
  })

  // A signal that aborted before the call means the caller stopped waiting: nothing may reach the database.
  it('sends nothing for a call whose signal already aborted', async () => {
    const client = new StubClient()
    const backend = new PostgresLockBackend(client)
    const aborted = AbortSignal.abort()

    await expect(backend.tryAcquire('orders', 1 * Second, aborted)).rejects.toBe(aborted.reason)
    await expect(backend.extend(lease, 1 * Second, aborted)).rejects.toBe(aborted.reason)
    await expect(backend.release(lease, aborted)).rejects.toBe(aborted.reason)
    expect(client.sent).toEqual([])
  })

  it('quotes a schema-qualified table in every statement', async () => {
    const client = new StubClient()
    const backend = new PostgresLockBackend(client, { table: 'locks.app_locks' })

    await backend.tryAcquire('orders', 1 * Second)
    await backend.extend(lease, 1 * Second)
    await backend.release(lease)

    expect(client.sent.map(s => s.text.split('\n')[0])).toEqual([
      'INSERT INTO "locks"."app_locks" AS held (key, token, fence, expires_at)',
      'UPDATE "locks"."app_locks"',
      'DELETE FROM "locks"."app_locks" WHERE key = $1 AND token = $2',
    ])
  })

  // The table name is spliced into SQL; anything but a plain identifier could carry a statement of its own.
  it.each(['locks; DROP TABLE users', 'Locks', '"locks"', 'a.b.c', '1locks', ''])(
    'refuses the table name %j',
    table => {
      expect(() => new PostgresLockBackend(new StubClient(), { table })).toThrow(ErrDistLockConfiguration)
      expect(() => postgresLockTableDDL(table)).toThrow(ErrDistLockConfiguration)
    },
  )
})

describe('postgresLockTableDDL', () => {
  it('creates the default table only when it is missing, with the columns the statements use', () => {
    expect(postgresLockTableDDL()).toBe(`CREATE TABLE IF NOT EXISTS "caffeine_locks" (
  key        text PRIMARY KEY,
  token      text NOT NULL,
  fence      bigint NOT NULL,
  expires_at timestamptz NOT NULL
)`)
  })
})
