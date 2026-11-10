import type { Duration } from '@caffeinejs/std/duration'

import type { Backend, LockLease } from './backend.js'
import { MemoryLockBackend } from './backend/memory/index.js'
import type { StoreOperation } from './store_call.js'

/**
 * A backend whose failures a test switches on: a key taken behind the holder's back, a backend that is down, one
 * that never answers, or one that answers late.
 */
export class FaultyBackend implements Backend {
  stolen = false
  failAcquire = false
  failExtend = false
  failRelease = false

  /** Hands out leases whose fencing token is `0`, which breaks the contract. */
  badFencing = false

  /** Operations whose calls never settle, and never take effect. */
  readonly hang = new Set<StoreOperation>()

  /**
   * Operations whose calls take effect at once but answer only when {@link answerLate} is called, so a test can
   * deliver the answer after the caller stopped waiting.
   */
  late: StoreOperation[] = []

  /** Every release that reached the inner backend, with the token it carried. */
  readonly released: LockLease[] = []

  readonly #inner: Backend
  readonly #pending: Array<() => void> = []

  constructor(inner: Backend = new MemoryLockBackend()) {
    this.#inner = inner
  }

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    if (this.failAcquire) {
      return Promise.reject(new Error('backend down'))
    }

    return this.#run('acquire', async () => {
      const lease = await this.#inner.tryAcquire(key, ttl)
      return this.badFencing && lease !== undefined ? { ...lease, fencingToken: 0 } : lease
    })
  }

  extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    if (this.failExtend) {
      return Promise.reject(new Error('backend down'))
    }

    return this.#run('extend', () => (this.stolen ? Promise.resolve(undefined) : this.#inner.extend(lease, ttl)))
  }

  release(lease: LockLease): Promise<void> {
    if (this.failRelease) {
      return Promise.reject(new Error('backend down'))
    }

    return this.#run('release', () => {
      this.released.push(lease)
      return this.#inner.release(lease)
    })
  }

  /** Delivers every answer held back by {@link late}, in the order the calls were made. */
  answerLate(): void {
    for (const answer of this.#pending.splice(0)) {
      answer()
    }
  }

  #run<T>(operation: StoreOperation, call: () => Promise<T>): Promise<T> {
    if (this.hang.has(operation)) {
      return new Promise<T>(() => undefined)
    }

    if (!this.late.includes(operation)) {
      return call()
    }

    const answer = call()
    // Held back until answerLate, so a rejection must not count as unhandled meanwhile.
    answer.catch(() => undefined)
    return new Promise<T>((resolve, reject) => {
      this.#pending.push(() => answer.then(resolve, reject))
    })
  }
}

/** Answers every extend with the next fencing token, which breaks the contract. */
export class RenumberingBackend implements Backend {
  readonly inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    return this.inner.tryAcquire(key, ttl)
  }

  async extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    const extended = await this.inner.extend(lease, ttl)
    return extended === undefined ? undefined : { ...extended, fencingToken: extended.fencingToken + 1 }
  }

  release(lease: LockLease): Promise<void> {
    return this.inner.release(lease)
  }
}

/** Hands out a new token on every extend, as {@link Backend.extend} allows. */
export class RotatingBackend implements Backend {
  readonly inner = new MemoryLockBackend()

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    return this.inner.tryAcquire(key, ttl)
  }

  async extend(lease: LockLease, ttl: Duration): Promise<LockLease | undefined> {
    if ((await this.inner.extend(lease, ttl)) === undefined) {
      return undefined
    }

    await this.inner.release(lease)
    const rotated = await this.inner.tryAcquire(lease.key, ttl)
    // A new token string, but the same fencing token: extend keeps it.
    return rotated === undefined ? undefined : { ...rotated, fencingToken: lease.fencingToken }
  }

  release(lease: LockLease): Promise<void> {
    return this.inner.release(lease)
  }
}

/** One extend held by {@link StagedBackend}: when it reaches the inner backend and when its caller hears back are the test's to pick. */
export interface StagedExtend {
  /** Applies the extend to the inner backend. */
  write(): Promise<void>

  /** Hands the caller what the write returned. */
  answer(): void
}

/**
 * A backend whose extends land and answer only when a test says so, each on its own, so two extends can land in
 * one order and answer in the other, as nothing in {@link Backend} rules out.
 */
export class StagedBackend implements Backend {
  /** Every extend made, in the order the calls were made. */
  readonly extends: StagedExtend[] = []

  /**
   * Whether an extend whose signal aborts before it was written rejects with the signal's reason and never
   * lands, as a backend that cancels a command it had not sent yet does.
   */
  cancelsUnwritten = false

  readonly inner: Backend

  constructor(inner: Backend = new MemoryLockBackend()) {
    this.inner = inner
  }

  tryAcquire(key: string, ttl: Duration): Promise<LockLease | undefined> {
    return this.inner.tryAcquire(key, ttl)
  }

  extend(lease: LockLease, ttl: Duration, signal?: AbortSignal): Promise<LockLease | undefined> {
    const { promise, resolve, reject } = Promise.withResolvers<LockLease | undefined>()
    let written: Promise<LockLease | undefined> | undefined

    signal?.addEventListener(
      'abort',
      () => {
        if (this.cancelsUnwritten && written === undefined) {
          reject(signal.reason)
        }
      },
      { once: true },
    )

    this.extends.push({
      write: async () => {
        written = this.inner.extend(lease, ttl)
        await written
      },
      answer: () => {
        written!.then(resolve, reject)
      },
    })

    return promise
  }

  release(lease: LockLease): Promise<void> {
    return this.inner.release(lease)
  }
}
