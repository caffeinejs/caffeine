import type { Backend, LockLease } from './backend.js'
import { MemoryLockBackend } from './backend/memory/index.js'

/** A backend whose failures a test switches on: a key taken behind the holder's back, or a backend that is down. */
export class FaultyBackend implements Backend {
  stolen = false
  failAcquire = false
  failExtend = false

  readonly #inner = new MemoryLockBackend()

  tryAcquire(key: string, ttlMs: number): Promise<LockLease | undefined> {
    if (this.failAcquire) {
      return Promise.reject(new Error('backend down'))
    }

    return this.#inner.tryAcquire(key, ttlMs)
  }

  extend(lease: LockLease, ttlMs: number): Promise<LockLease | undefined> {
    if (this.failExtend) {
      return Promise.reject(new Error('backend down'))
    }

    return this.stolen ? Promise.resolve(undefined) : this.#inner.extend(lease, ttlMs)
  }

  release(lease: LockLease): Promise<void> {
    return this.#inner.release(lease)
  }
}
