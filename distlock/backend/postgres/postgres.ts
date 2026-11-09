import { randomUUID } from 'node:crypto'

import type { Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import type { Backend, LockLease } from '../../backend.js'
import { ErrDistLockConfiguration } from '../../errors.js'

/**
 * The part of a node-postgres `Pool` or `Client` this backend calls. A `Pool` from `pg` satisfies it, and is the
 * one to pass: each call is one statement, so it needs no connection of its own.
 */
export interface PostgresLockClient {
  query<R extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
}

/** Where a {@link PostgresLockBackend} keeps its locks. */
export interface PostgresLockBackendOptions {
  /**
   * The table the locks live in, optionally schema-qualified (`locks.caffeine_locks`). Defaults to
   * `caffeine_locks`. It must exist: create it with {@link postgresLockTableDDL}.
   */
  table?: string
}

const DEFAULT_TABLE = 'caffeine_locks'

// Lowercase identifiers only, so the name needs no case folding to match what `CREATE TABLE` made of it.
const TABLE_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/

// Validated, then quoted: a table name is the one piece of SQL that cannot be a parameter.
function quotedTable(table: string): string {
  if (!TABLE_NAME.test(table)) {
    throw new ErrDistLockConfiguration(
      errMessage(`Cannot use "${table}" as the lock table: it is not a lowercase name, optionally schema-qualified`)
        .solutions('Pass a name such as "caffeine_locks" or "locks.caffeine_locks"')
        .reference('@caffeinejs/distlock', ErrDistLockConfiguration)
        .build(),
    )
  }

  return table
    .split('.')
    .map(part => `"${part}"`)
    .join('.')
}

/**
 * The `CREATE TABLE` statement for the lock table, for a migration. Running it again changes nothing.
 *
 * A row lives while its key is held, and release deletes it. A row whose `expires_at` has passed may be deleted
 * at any time: fencing tokens keep increasing without it as long as the database clock does not step back.
 *
 * @throws {@link ErrDistLockConfiguration} when `table` is not a lowercase name, optionally schema-qualified.
 */
export function postgresLockTableDDL(table: string = DEFAULT_TABLE): string {
  return `CREATE TABLE IF NOT EXISTS ${quotedTable(table)} (
  key        text PRIMARY KEY,
  token      text NOT NULL,
  fence      bigint NOT NULL,
  expires_at timestamptz NOT NULL
)`
}

/**
 * A backend that locks on rows of one PostgreSQL table.
 *
 * The client is the caller's: this backend never connects or ends it. Every operation is one atomic statement
 * timed by the database clock, so clients whose clocks disagree still agree on when a lease ends.
 *
 * The fencing token is the last one issued for the key plus one, floored by the database clock in microseconds,
 * so it keeps increasing after a released row is gone. Fencing is as durable as the database's clock and data: a
 * failover to a replica that had not received a row can hand its key to a second holder.
 *
 * It expects the default `read committed` isolation. Under `repeatable read` or `serializable` set as the
 * database's or the role's default, contended acquisitions fail with a serialization error instead of finding the
 * key held, and the lock service reports each as a backend failure.
 *
 * The signal each call takes is checked before the statement goes out; `pg` cannot cancel a query already sent.
 * The lock service gives back whatever lease such a query returns late. Give the pool a `statement_timeout`, so a
 * statement the service stopped waiting for does not hold a connection.
 *
 * @throws {@link ErrDistLockConfiguration} from the constructor when `table` is not a lowercase name, optionally
 * schema-qualified.
 */
export class PostgresLockBackend implements Backend {
  readonly #client: PostgresLockClient
  readonly #acquire: string
  readonly #extend: string
  readonly #release: string

  constructor(client: PostgresLockClient, options: PostgresLockBackendOptions = {}) {
    const table = quotedTable(options.table ?? DEFAULT_TABLE)

    this.#client = client
    // Takes a free or lapsed key, in one statement. Zero rows: the key is held.
    this.#acquire = `INSERT INTO ${table} AS held (key, token, fence, expires_at)
VALUES ($1, $2, (extract(epoch FROM clock_timestamp()) * 1000000)::bigint, clock_timestamp() + $3::interval)
ON CONFLICT (key) DO UPDATE
  SET token = EXCLUDED.token,
      fence = GREATEST(held.fence + 1, EXCLUDED.fence),
      expires_at = EXCLUDED.expires_at
  WHERE held.expires_at <= clock_timestamp()
RETURNING fence`
    this.#extend = `UPDATE ${table}
SET expires_at = clock_timestamp() + $3::interval
WHERE key = $1 AND token = $2 AND expires_at > clock_timestamp()
RETURNING fence`
    this.#release = `DELETE FROM ${table} WHERE key = $1 AND token = $2`
  }

  async tryAcquire(key: string, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    signal?.throwIfAborted()

    // An interval written in whole milliseconds.
    const ms = Math.ceil(ttl)
    const token = randomUUID()
    const start = Date.now()
    const { rows } = await this.#client.query<{ fence: string }>(this.#acquire, [key, token, `${ms} milliseconds`])
    if (rows.length === 0) {
      return undefined
    }

    // `bigint` arrives as text. The core refuses a token that is not a positive safe integer and gives the lease
    // back.
    const fencingToken = Number(rows[0].fence)

    // The row was written at or after `start`, so this is the earliest the database can expire it.
    return { key, token, fencingToken, expiresAt: start + ms }
  }

  async extend(lease: LockLease, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    signal?.throwIfAborted()

    const ms = Math.ceil(ttl)
    const start = Date.now()
    const { rows } = await this.#client.query(this.#extend, [lease.key, lease.token, `${ms} milliseconds`])
    if (rows.length === 0) {
      return undefined
    }

    return { ...lease, expiresAt: start + ms }
  }

  async release(lease: LockLease, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()

    await this.#client.query(this.#release, [lease.key, lease.token])
  }
}
