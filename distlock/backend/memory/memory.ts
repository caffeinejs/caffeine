import { randomUUID } from 'node:crypto'

import type { Backend, LockLease } from '../../backend.js'

interface Held {
  token: string
  expiresAt: number
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

  async tryAcquire(key: string, ttlMs: number): Promise<LockLease | undefined> {
    if (this.#live(key) !== undefined) {
      return undefined
    }

    const lease = { key, token: randomUUID(), expiresAt: Date.now() + ttlMs }
    this.#held.set(key, { token: lease.token, expiresAt: lease.expiresAt })

    return lease
  }

  async extend(lease: LockLease, ttlMs: number): Promise<LockLease | undefined> {
    const held = this.#live(lease.key)
    if (held === undefined || held.token !== lease.token) {
      return undefined
    }

    held.expiresAt = Date.now() + ttlMs

    return { key: lease.key, token: lease.token, expiresAt: held.expiresAt }
  }

  async release(lease: LockLease): Promise<void> {
    const held = this.#live(lease.key)
    if (held !== undefined && held.token === lease.token) {
      this.#held.delete(lease.key)
    }
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
