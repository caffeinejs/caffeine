import { toMillis, type Duration } from '@caffeinejs/std'
import type { Logger } from '@caffeinejs/std/logger'

import { extendChannel, publishLost, releaseChannel, traced, type Writable } from './_channels.js'
import type { Backend, LockLease } from './backend.js'
import type { DistLock, Lock } from './distlock.js'
import type { ExtendContext, ReleaseContext, WithLockContext } from './observability/channels.js'
import type { DistLockOptions } from './options.js'

// What a lock needs from the service that handed it out. Declared here, over a type-only import, so the two
// modules share no runtime dependency. It extends `DistLock` because every context a lock publishes names the
// service it came from, and the host is what the lock hands over as `service`.
export interface LockHost extends DistLock {
  readonly backend: Backend
  readonly options: DistLockOptions
  readonly log: Logger
  track(lock: HeldLock): void
  untrack(lock: HeldLock): void
}

// Process-wide rather than per service, so a lease ID is unique across every lock service in the process.
let nextLeaseID = 0

export class HeldLock implements Lock {
  readonly key: string
  readonly leaseID: number
  readonly acquiredAt: number

  // The `withLock` call holding this lock, set by the service once the key is taken, so the release publishes
  // where it ran.
  within: WithLockContext | undefined

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
    this.leaseID = ++nextLeaseID
    this.acquiredAt = Date.now()
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

  // Whether the lease is gone for a reason nobody has reported yet: it lapsed by the clock, with no renewal
  // noticing. A lease a renewal found taken was already reported as lost.
  get lapsedUnreported(): boolean {
    return !this.#taken && Date.now() >= this.#lease.expiresAt
  }

  async extend(ttl?: Duration): Promise<boolean> {
    if (this.#released || this.#taken) {
      return false
    }

    const ttlMs = ttl === undefined ? this.#ttlMs : toMillis(ttl)

    return traced(
      extendChannel,
      () => this.#extendContext(ttlMs, false),
      ctx => this.#extendLease(ttlMs, false, ctx),
    )
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

    await traced(
      releaseChannel,
      (): Writable<ReleaseContext> => ({
        service: this.#host,
        key: this.key,
        leaseID: this.leaseID,
        parent: this.within,
      }),
      ctx => this.#releaseLease(ctx),
    )
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

    const ttlMs = this.#ttlMs

    // A renewal that cannot reach the backend is a lost lease, not a crash in whatever the holder is doing.
    // Marked lost here, once the extend channel has settled, so the loss is published after the failure that
    // caused it.
    const renewed = await traced(
      extendChannel,
      () => this.#extendContext(ttlMs, true),
      ctx => this.#extendLease(ttlMs, true, ctx),
    ).catch(() => {
      this.#lose('error', true)
      return false
    })

    // The only path that arms another timer, and it declines once renewal has been stopped.
    if (renewed) {
      this.#schedule()
    }
  }

  #extendContext(ttlMs: number, renewal: boolean): Writable<ExtendContext> {
    return { service: this.#host, key: this.key, leaseID: this.leaseID, ttlMs, renewal }
  }

  // Every state change an extension makes happens here, before the promise settles, so a subscriber reading the
  // lock at `asyncEnd` sees it as it now is. The one exception is the loss a failed renewal causes: `#renew`
  // marks that after the channel has settled, so the loss is published after the failure.
  async #extendLease(ttlMs: number, renewal: boolean, ctx: Writable<ExtendContext> | undefined): Promise<boolean> {
    let next: LockLease | undefined
    try {
      next = await this.#host.backend.extend(this.#lease, ttlMs)
    } catch (error) {
      this.#host.log.warn(
        { err: error, key: this.key, leaseID: this.leaseID, operation: 'extend' },
        'lock backend failed',
      )

      if (ctx !== undefined) {
        ctx.outcome = 'error'
      }

      // The lease is left as it was. An explicit extend lets its caller decide; a renewal marks it lost once
      // this has settled.
      throw error
    }

    if (next === undefined) {
      if (ctx !== undefined) {
        ctx.outcome = 'lost'
      }

      this.#lose('taken', renewal)

      return false
    }

    // Assigned even when this lock was released or stopped mid-flight: a release waiting behind this
    // renewal has to send the lease the renewal left behind, not the one it superseded.
    this.#lease = next

    // Every renewal from here on runs on what an explicit extend asked for. A renewal leaves it alone: one
    // that left before an explicit extend landed would otherwise put the old duration back.
    if (!renewal) {
      this.#ttlMs = ttlMs
    }

    if (ctx !== undefined) {
      ctx.outcome = 'extended'
      ctx.expiresAt = next.expiresAt
    }

    this.#host.log.debug({ key: this.key, leaseID: this.leaseID, ttlMs, renewal }, 'lock extended')

    return true
  }

  #lose(reason: 'taken' | 'error', renewal: boolean): void {
    this.#taken = true
    this.stopRenewal()

    // A backend failure was already logged as a warning; the loss it caused is the same incident.
    const fields = { key: this.key, leaseID: this.leaseID, reason, renewal }
    if (reason === 'taken') {
      this.#host.log.warn(fields, 'lock lease lost')
    } else {
      this.#host.log.debug(fields, 'lock lease lost')
    }

    publishLost(() => ({ service: this.#host, ...fields }))
  }

  async #releaseLease(ctx: Writable<ReleaseContext> | undefined): Promise<void> {
    const heldMs = Date.now() - this.acquiredAt
    const lapsed = this.#taken || Date.now() >= this.#lease.expiresAt
    const unreported = this.lapsedUnreported

    if (ctx !== undefined) {
      ctx.heldMs = heldMs
      ctx.lapsed = lapsed
    }

    try {
      // Sent even when the lease looks lapsed by the local clock: the backend compares tokens, so it is the
      // one that decides, and a release that arrives late is a no-op rather than a key taken from its new
      // holder.
      await this.#host.backend.release(this.#lease)
    } catch (error) {
      this.#host.log.warn(
        { err: error, key: this.key, leaseID: this.leaseID, operation: 'release' },
        'lock backend failed',
      )
      throw error
    }

    const fields = { key: this.key, leaseID: this.leaseID, heldMs }
    if (unreported) {
      this.#host.log.warn(fields, 'lock released after its lease lapsed')
    } else {
      this.#host.log.debug({ ...fields, lapsed }, 'lock released')
    }
  }
}
