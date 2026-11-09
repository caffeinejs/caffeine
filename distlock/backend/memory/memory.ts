import { randomUUID } from 'node:crypto'

import type { Duration } from '@caffeinejs/std/duration'

import type { Backend, LockLease } from '../../backend.js'

interface Held {
  token: string
  fencingToken: number
  expiresAt: number
}

// Shared by every instance in the process, so a token stays greater than every one issued before even when the
// key's state is gone: after an expiry, a release, or a new backend instance.
let lastFence = 0

// Greater than the last token issued, and never below the clock in microseconds, so tokens keep increasing across
// state the backend no longer has.
function nextFence(): number {
  lastFence = Math.max(lastFence + 1, Date.now() * 1000)
  return lastFence
}

/**
 * A backend that keeps its keys in one process.
 *
 * It is a real lock only for the replicas sharing the instance — which is one, unless a test wires two
 * applications to the same object. Use it for tests and for a deployment that genuinely runs a single
 * replica; anything else needs a backend backed by something the replicas share.
 */
export class MemoryLockBackend implements Backend {
  readonly #held = new Map<string, Held>()

  tryAcquire(key: string, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason)
    }

    if (this.#live(key) !== undefined) {
      return Promise.resolve(undefined)
    }

    const lease = { key, token: randomUUID(), fencingToken: nextFence(), expiresAt: Date.now() + ttl }
    this.#held.set(key, { token: lease.token, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt })

    return Promise.resolve(lease)
  }

  extend(lease: LockLease, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason)
    }

    const held = this.#live(lease.key)
    if (held === undefined || held.token !== lease.token) {
      return Promise.resolve(undefined)
    }

    held.expiresAt = Date.now() + ttl

    return Promise.resolve({
      key: lease.key,
      token: lease.token,
      fencingToken: held.fencingToken,
      expiresAt: held.expiresAt,
    })
  }

  release(lease: LockLease, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason)
    }

    const held = this.#live(lease.key)
    if (held !== undefined && held.token === lease.token) {
      this.#held.delete(lease.key)
    }

    return Promise.resolve()
  }

  // Expiry is lazy: a lapsed key is indistinguishable from a free one, and dropping it on read keeps the map
  // from growing for keys nobody asks about again.
  #live(key: string): Held | undefined {
    const held = this.#held.get(key)
    if (held === undefined) {
      return undefined
    }

    if (Date.now() >= held.expiresAt) {
      this.#held.delete(key)
      return undefined
    }

    return held
  }
}
