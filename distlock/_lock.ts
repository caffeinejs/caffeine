import { toMillis, type Duration } from '@caffeinejs/std'

import type { Backend, LockLease } from './backend.js'
import type { Lock } from './distlock.js'
import type { DistLockOptions } from './options.js'

// What a lock needs from the service that handed it out. Declared here rather than imported from the runtime
// so the two modules do not depend on each other.
export interface LockHost {
  readonly backend: Backend
  readonly options: DistLockOptions
  track(lock: HeldLock): void
  untrack(lock: HeldLock): void
}

export class HeldLock implements Lock {
  readonly key: string

  readonly #host: LockHost

  #ttlMs: number
  #lease: LockLease
  #released = false
  #taken = false
  #stopped = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #renewal: Promise<void> | undefined

  constructor(host: LockHost, lease: LockLease, ttlMs: number, renew: boolean) {
    this.key = lease.key
    this.#host = host
    this.#lease = lease
    this.#ttlMs = ttlMs

    if (renew) {
      host.track(this)
      this.#schedule()
    }
  }

  get token(): string {
    return this.#lease.token
  }

  get expiresAt(): number {
    return this.#lease.expiresAt
  }

  get lost(): boolean {
    return this.#released || this.#taken || Date.now() >= this.#lease.expiresAt
  }

  async extend(ttl?: Duration): Promise<boolean> {
    if (this.#released || this.#taken) {
      return false
    }

    const ttlMs = ttl === undefined ? this.#ttlMs : toMillis(ttl)

    const next = await this.#host.backend.extend(this.#lease, ttlMs)
    if (next === undefined) {
      this.#taken = true
      this.stopRenewal()
      return false
    }

    this.#lease = next
    // Every renewal from here on runs on what this call asked for, rather than reverting to the duration the
    // lock was acquired with.
    this.#ttlMs = ttlMs

    return true
  }

  async release(): Promise<void> {
    if (this.#released) {
      return
    }

    this.#released = true
    this.stopRenewal()

    // A renewal already on the wire has to land first, or its write outlives the release and the key stays
    // taken for another lease. Reading the lease afterwards is what makes that safe: it is the one the
    // renewal left behind.
    await this.settled()

    // Sent even when the lease looks lapsed by the local clock: the backend compares tokens, so it is the one
    // that decides, and a release that arrives late is a no-op rather than a key taken from its new holder.
    await this.#host.backend.release(this.#lease)
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.release()
  }

  // Stops renewing without touching the key. What shutdown calls, and what `once` calls when it leaves the
  // window standing.
  stopRenewal(): void {
    this.#stopped = true

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }

    this.#host.untrack(this)
  }

  // Resolves once no renewal is in flight. A renewal that already reached the backend cannot be called back,
  // so disposal waits for it rather than leaving a write behind.
  settled(): Promise<void> {
    return this.#renewal ?? Promise.resolve()
  }

  #schedule(): void {
    // Whoever stopped renewal did so while this one was in flight, and it is the last.
    if (this.#stopped) {
      return
    }

    // A third of what is left: two renewals may fail before the lease actually lapses.
    const delay = Math.max(1, Math.floor((this.#lease.expiresAt - Date.now()) / 3))

    this.#timer = setTimeout(() => {
      this.#renewal = this.#renew().finally(() => {
        this.#renewal = undefined
      })
    }, delay)
    // Never the last thing keeping a process alive.
    this.#timer.unref?.()
  }

  async #renew(): Promise<void> {
    this.#timer = undefined

    if (this.#released || this.#taken) {
      return
    }

    try {
      const next = await this.#host.backend.extend(this.#lease, this.#ttlMs)
      if (next === undefined) {
        this.#taken = true
        this.#host.untrack(this)
        return
      }

      // Assigned even when this lock was released or stopped mid-flight: a release waiting behind this
      // renewal has to send the lease the renewal left behind, not the one it superseded.
      this.#lease = next
    } catch {
      // A renewal that cannot reach the backend is a lost lease, not a crash in whatever the holder is doing.
      this.#taken = true
      this.#host.untrack(this)
      return
    }

    // The only path that arms another timer, and it declines once renewal has been stopped.
    this.#schedule()
  }
}
