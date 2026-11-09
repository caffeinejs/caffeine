import { randomUUID } from 'node:crypto'

import { Day, type Duration } from '@caffeinejs/std/duration'

import type { Backend, LockLease } from '../../backend.js'

/**
 * The part of a node-redis client this backend calls. A client from `createClient()` or `createCluster()`
 * satisfies it, imported from `@redis/client` or from `redis`, which re-exports it.
 */
export interface RedisLockClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** How a {@link RedisLockBackend} names its keys. */
export interface RedisLockBackendOptions {
  /**
   * The key that keeps the last fencing token issued for a lock key. Defaults to `{key}:fence`, whose hash tag
   * puts it in the lock key's slot on a cluster, or to `key:fence` when the lock key carries a hash tag of its own
   * (`{tenant}:orders` gives `{tenant}:orders:fence`). A key with a `{` but no hash tag, such as `{}:orders`, has
   * no default in its slot, and on a cluster its acquisition fails with `CROSSSLOT`: name its fence key here.
   *
   * Never lock a key the default names as a fence key, such as `{orders}:fence`: each acquisition of `orders`
   * overwrites it.
   */
  fenceKey?: (key: string) => string
}

// Takes the key, numbers the acquisition and keeps the number, in one atomic round trip. The fence is the last
// token + 1, floored by the server clock in microseconds, so it keeps increasing after the fence key is gone.
// `%.0f` keeps Lua from writing 1.8e+15.
const ACQUIRE = `if redis.call("set", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  local now = redis.call("time")
  local floor = tonumber(now[1]) * 1000000 + tonumber(now[2])
  local fence = math.max((tonumber(redis.call("get", KEYS[2])) or 0) + 1, floor)
  redis.call("set", KEYS[2], string.format("%.0f", fence), "PX", ARGV[3])
  return string.format("%.0f", fence)
end
return false`
const EXTEND = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

// How long a fence key outlives its last acquisition. It is a cache in front of the clock floor, not the
// guarantee, so it needs no tuning.
const FENCE_TTL: Duration = 1 * Day

// A cluster hashes only the text between the first `{` and the next `}`, when it is not empty. A key that has such a
// tag keeps it; any other key is wrapped in one.
function defaultFenceKey(key: string): string {
  const open = key.indexOf('{')
  const close = open === -1 ? -1 : key.indexOf('}', open + 1)
  return close > open + 1 ? `${key}:fence` : `{${key}}:fence`
}

/**
 * A backend that locks on keys of one Redis or Valkey server, or of a cluster.
 *
 * The client is the caller's: it is expected connected, and this backend never connects, closes, or reconnects
 * it. Closing it is the application's job, after the lock service has been disposed.
 *
 * It is a single-instance lock. A server that fails over to a replica which had not yet received a key can
 * hand that key to a second holder while the first still believes it holds it, and can issue a lower fencing
 * token if its clock is behind the primary's by more than the time since that acquisition. Fencing is as durable
 * as the server's clock and data.
 *
 * The signal each call takes is checked before the command goes out, never handed to the client: a command
 * already sent may have landed, and the lock service gives back whatever lease it returns late. Give the client
 * a command timeout of its own, so a command the service stopped waiting for does not hold the connection.
 */
export class RedisLockBackend implements Backend {
  readonly #client: RedisLockClient
  readonly #fenceKey: (key: string) => string

  constructor(client: RedisLockClient, options: RedisLockBackendOptions = {}) {
    this.#client = client
    this.#fenceKey = options.fenceKey ?? defaultFenceKey
  }

  async tryAcquire(key: string, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    signal?.throwIfAborted()

    // `PX` takes whole milliseconds.
    const px = Math.ceil(ttl)
    const token = randomUUID()
    const start = Date.now()
    const reply = await this.#client.eval(ACQUIRE, {
      keys: [key, this.#fenceKey(key)],
      arguments: [token, String(px), String(FENCE_TTL)],
    })
    if (reply === null || reply === undefined) {
      return undefined
    }

    // The core refuses a token that is not a positive safe integer and gives the lease back.
    const fencingToken = Number(reply)

    // The key was written at or after `start`, so this is the earliest the server can expire it.
    return { key, token, fencingToken, expiresAt: start + px }
  }

  async extend(lease: LockLease, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    signal?.throwIfAborted()

    const px = Math.ceil(ttl)
    const start = Date.now()
    const reply = await this.#client.eval(EXTEND, { keys: [lease.key], arguments: [lease.token, String(px)] })
    if (reply !== 1) {
      return undefined
    }

    return { ...lease, expiresAt: start + px }
  }

  async release(lease: LockLease, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()

    await this.#client.eval(RELEASE, { keys: [lease.key], arguments: [lease.token] })
  }
}
