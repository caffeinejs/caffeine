import { randomUUID } from 'node:crypto'

import type { Backend, LockLease } from '../../backend.js'

/**
 * The part of a node-redis client this backend calls. A client from `createClient()` satisfies it, imported from
 * `@redis/client` or from `redis`, which re-exports it.
 */
export interface RedisLockClient {
  set(
    key: string,
    value: string,
    options: { expiration: { type: 'PX'; value: number }; condition: 'NX' },
  ): Promise<unknown>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const EXTEND = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

/**
 * A backend that locks on keys of one Redis or Valkey server.
 *
 * The client is the caller's: it is expected connected, and this backend never connects, closes, or reconnects
 * it. Closing it is the application's job, after the lock service has been disposed.
 *
 * It is a single-instance lock. A server that fails over to a replica which had not yet received a key can
 * hand that key to a second holder while the first still believes it holds it.
 */
export class RedisLockBackend implements Backend {
  readonly #client: RedisLockClient

  constructor(client: RedisLockClient) {
    this.#client = client
  }

  async tryAcquire(key: string, ttlMs: number, signal?: AbortSignal): Promise<LockLease | undefined> {
    signal?.throwIfAborted()

    const token = randomUUID()
    const start = Date.now()
    const reply = await this.#client.set(key, token, {
      expiration: { type: 'PX', value: ttlMs },
      condition: 'NX',
    })
    if (reply !== 'OK') {
      return undefined
    }

    // The key was written at or after `start`, so this is the earliest the server can expire it.
    return { key, token, expiresAt: start + ttlMs }
  }

  async extend(lease: LockLease, ttlMs: number): Promise<LockLease | undefined> {
    const start = Date.now()
    const reply = await this.#client.eval(EXTEND, { keys: [lease.key], arguments: [lease.token, String(ttlMs)] })
    if (reply !== 1) {
      return undefined
    }

    return { key: lease.key, token: lease.token, expiresAt: start + ttlMs }
  }

  async release(lease: LockLease): Promise<void> {
    await this.#client.eval(RELEASE, { keys: [lease.key], arguments: [lease.token] })
  }
}
