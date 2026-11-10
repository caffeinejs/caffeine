import type { Logger } from '@caffeinejs/application/logger'
import type { Duration } from '@caffeinejs/std/duration'

import { extendChannel, publishLost, releaseChannel, traced, type Writable } from './_channels.js'
import type { Backend, LockLease } from './backend.js'
import type { DistLock, Lock } from './distlock.js'
import { ErrLockBackendTimeout } from './errors.js'
import type { ExtendContext, ReleaseContext, WithLockContext } from './observability/channels.js'
import type { DistLockOptions } from './options.js'
import { boundedCall } from './store_call.js'

// What a lock needs from the service that handed it out. Declared here, over a type-only import, so the two
// modules share no runtime dependency. It extends `DistLock` because every context a lock publishes names the
// service it came from, and the host is what the lock hands over as `service`.
export interface LockHost extends DistLock {
  readonly backend: Backend
  readonly options: DistLockOptions
  readonly log: Logger

  // Releases a lease that arrived after nobody wanted it any more.
  giveBack(lease: LockLease): void
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
  // The locks the service renews, when this one renews: it joins on construction and leaves once renewal stops, so
  // the service's `onDestroy` reaches every renewal still running and nothing else.
  readonly #renewing: Set<HeldLock> | undefined

  #ttl: Duration
  #lease: LockLease
  #released = false
  #taken = false
  #stopped = false
  // Set for a `once` lock: its key is the window, and nothing but its holder lets go of it.
  readonly #window: boolean
  // Explicit extends that timed out and have not answered. Each may have shortened the lease already, so until it
  // answers, the lease this lock knows is not one it can vouch for.
  #unsettled = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #renewal: Promise<void> | undefined

  constructor(host: LockHost, lease: LockLease, ttl: Duration, renewing: Set<HeldLock> | undefined, window = false) {
    this.key = lease.key
    this.leaseID = ++nextLeaseID
    this.acquiredAt = Date.now()
    this.#host = host
    this.#renewing = renewing
    this.#lease = lease
    this.#ttl = ttl
    this.#window = window

    if (renewing !== undefined) {
      renewing.add(this)
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
    return this.#released || this.#taken || this.#unsettled > 0 || Date.now() >= this.#lease.expiresAt
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

    const span = ttl ?? this.#ttl

    return traced(
      extendChannel,
      () => this.#extendContext(span, false),
      ctx => this.#extendLease(span, false, ctx),
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

    this.#renewing?.delete(this)
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

    const ttl = this.#ttl

    // A renewal that cannot reach the backend is a lost lease, not a crash in whatever the holder is doing.
    // Marked lost here, once the extend channel has settled, so the loss is published after the failure that
    // caused it.
    const renewed = await traced(
      extendChannel,
      () => this.#extendContext(ttl, true),
      ctx => this.#extendLease(ttl, true, ctx),
    ).catch(() => {
      this.#lose('error', true)
      return false
    })

    // The only path that arms another timer, and it declines once renewal has been stopped.
    if (renewed) {
      this.#schedule()
    }
  }

  #extendContext(ttl: Duration, renewal: boolean): Writable<ExtendContext> {
    return { service: this.#host, key: this.key, leaseID: this.leaseID, ttl, renewal }
  }

  // Every state change an extension makes happens here, before the promise settles, so a subscriber reading the
  // lock at `asyncEnd` sees it as it now is. The one exception is the loss a failed renewal causes: `#renew`
  // marks that after the channel has settled, so the loss is published after the failure.
  //
  // Waits at most what is left of the lease, or `storeTimeout` when that is shorter: an answer arriving after the
  // lease lapsed could only extend one already gone.
  async #extendLease(ttl: Duration, renewal: boolean, ctx: Writable<ExtendContext> | undefined): Promise<boolean> {
    const { storeTimeout } = this.#host.options
    const remaining = Math.max(1, this.#lease.expiresAt - Date.now())
    const sent = this.#lease
    // Whether the backend answered after this call stopped waiting, and whether this call counted itself in
    // `#unsettled`. The late answer and the catch below can run in either order.
    const call = { answered: false, abandoned: false }

    let next: LockLease | undefined
    try {
      next = await boundedCall(
        {
          operation: 'extend',
          key: this.key,
          timeout: Math.min(storeTimeout, remaining),
          bound: storeTimeout <= remaining ? 'storeTimeout' : 'ttl',
        },
        signal => this.#host.backend.extend(sent, ttl, signal),
        late => {
          this.#answered(call)
          this.#adoptLate(late, sent, renewal)
        },
        (error: unknown, cancelled: boolean) => {
          this.#answered(call)
          this.#host.log.debug(
            { err: error, key: this.key, leaseID: this.leaseID, operation: 'extend' },
            'lock backend failed late',
          )

          // A cancelled extension never took effect, so the lease it was sent on stands. After any other failure
          // whether it took effect is unknown for good, so the lease is no longer one to rely on.
          if (!cancelled && !renewal && !this.#released && !this.#taken) {
            this.#lose('error', false)
          }
        },
      )
    } catch (error) {
      // The backend may have applied an extension it did not answer in time, and a shorter ttl shortens the lease:
      // until the answer arrives, the lock reads as lost. A renewal that timed out is marked lost outright.
      if (!renewal && error instanceof ErrLockBackendTimeout && !call.answered) {
        call.abandoned = true
        this.#unsettled += 1
      }

      this.#host.log.warn(
        { err: error, key: this.key, leaseID: this.leaseID, operation: 'extend' },
        'lock backend failed',
      )

      if (ctx !== undefined) {
        ctx.outcome = 'error'
      }

      // An explicit extend lets its caller decide; a renewal marks the lease lost once this has settled.
      throw error
    }

    if (next === undefined) {
      if (ctx !== undefined) {
        ctx.outcome = 'lost'
      }

      this.#lose('taken', renewal)

      return false
    }

    // Taken even when this lock was released or stopped mid-flight: a release waiting behind this
    // renewal has to send the lease the renewal left behind, not the one it superseded.
    this.#reconcile(next, sent)

    // Every renewal from here on runs on what an explicit extend asked for. A renewal leaves it alone: one
    // that left before an explicit extend landed would otherwise put the old duration back.
    if (!renewal) {
      this.#ttl = ttl
    }

    if (ctx !== undefined) {
      ctx.outcome = 'extended'
      ctx.expiresAt = this.#lease.expiresAt
    }

    this.#host.log.debug({ key: this.key, leaseID: this.leaseID, ttlMs: ttl, renewal }, 'lock extended')

    return true
  }

  #answered(call: { answered: boolean; abandoned: boolean }): void {
    call.answered = true
    if (call.abandoned) {
      this.#unsettled -= 1
    }
  }

  // An extension that answered after the lock stopped waiting for it.
  //
  // A `once` window keeps whatever its key now carries until its holder lets go, lost lease or not: giving the
  // answer back would free the key under an action still running. A release the action asks for then sends the
  // token the key carries.
  //
  // A renewal that timed out marks the lease lost, possibly only after this runs, so its lease is given back. After
  // shutdown the service sends nothing, so it lapses instead.
  //
  // An explicit extend on a lock still held is reconciled with the lease the lock carries when it was sent on that
  // lease or answered under its token. Anything else gives the lease back, or a backend that rotates the token on
  // extend would keep the key under a token nobody holds.
  #adoptLate(late: LockLease | undefined, sent: LockLease, renewal: boolean): void {
    const held = !this.#released && !this.#taken

    if (late === undefined) {
      // The backend refused the token the call carried. That is news only while the lock still carries it: a newer
      // extend may have moved the key to another.
      if (!renewal && held && sent.token === this.#lease.token) {
        this.#lose('taken', false)
      }
      return
    }

    if (this.#window && !this.#released) {
      this.#reconcile(late, sent)
      return
    }

    if (renewal) {
      this.#host.giveBack(late)
      return
    }

    if (held && (this.#lease === sent || late.token === this.#lease.token)) {
      this.#reconcile(late, sent)
      return
    }

    this.#host.giveBack(late)
  }

  // Takes an extension's answer, on time or late, unless a newer one already replaced the lease it was sent with.
  // Two extends under one token may land in either order whatever order they answer in, so between their answers
  // the earlier expiry is the one the lock can rely on.
  #reconcile(next: LockLease, sent: LockLease): void {
    if (this.#lease === sent || (next.token === this.#lease.token && next.expiresAt < this.#lease.expiresAt)) {
      this.#lease = next
    }
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
    const held = Date.now() - this.acquiredAt
    const lapsed = this.#taken || Date.now() >= this.#lease.expiresAt
    const unreported = this.lapsedUnreported

    if (ctx !== undefined) {
      ctx.held = held
      ctx.lapsed = lapsed
    }

    try {
      // Sent even when the lease looks lapsed by the local clock: the backend compares tokens, so it is the
      // one that decides, and a release that arrives late is a no-op rather than a key taken from its new
      // holder.
      const lease = this.#lease
      await boundedCall(
        { operation: 'release', key: this.key, timeout: this.#host.options.storeTimeout, bound: 'storeTimeout' },
        signal => this.#host.backend.release(lease, signal),
        undefined,
        (error: unknown) =>
          this.#host.log.debug(
            { err: error, key: this.key, leaseID: this.leaseID, operation: 'release' },
            'lock backend failed late',
          ),
      )
    } catch (error) {
      this.#host.log.warn(
        { err: error, key: this.key, leaseID: this.leaseID, operation: 'release' },
        'lock backend failed',
      )
      throw error
    }

    const fields = { key: this.key, leaseID: this.leaseID, heldMs: held }
    if (unreported) {
      this.#host.log.warn(fields, 'lock released after its lease lapsed')
    } else {
      this.#host.log.debug({ ...fields, lapsed }, 'lock released')
    }
  }
}
