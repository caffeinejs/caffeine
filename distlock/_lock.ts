import type { Logger } from '@caffeinejs/application/logger'
import type { Duration } from '@caffeinejs/std/duration'

import { extendChannel, publishLost, releaseChannel, traced, type Writable } from './_channels.js'
import type { Backend, LockLease } from './backend.js'
import type { DistLock, Lock } from './distlock.js'
import { ErrLockLost, ErrLockReleased } from './errors.js'
import type { ExtendContext, LostReason, ReleaseContext, WithLockContext } from './observability/channels.js'
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

// The longest delay `setTimeout` honours; a longer deadline is reached in steps of at most this.
const MAX_TIMER_DELAY = 2 ** 31 - 1

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
  // Set by the one loss a lease can have, whichever of the deadline, a renewal or shutdown notices it first.
  #taken = false
  // Whether a lapse of this lease was already warned about, so no later warning repeats it.
  #lapseWarned = false
  // Set once `once` leaves its window standing: the lease is out of the holder's hands, so nothing about it aborts
  // or is published any more.
  #detached = false
  #stopped = false
  // Set while a renewal that failed is about to mark the lease lost, so its late answer is given back.
  #givingUp = false
  // Whether a renewal of this lease failed since the last one that succeeded, so retries stay at `debug`.
  #renewalFailed = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #deadline: ReturnType<typeof setTimeout> | undefined
  #renewal: Promise<void> | undefined
  readonly #controller = new AbortController()

  constructor(host: LockHost, lease: LockLease, ttl: Duration, renewing: Set<HeldLock> | undefined) {
    this.key = lease.key
    this.leaseID = ++nextLeaseID
    this.acquiredAt = Date.now()
    this.#host = host
    this.#renewing = renewing
    this.#lease = lease
    this.#ttl = ttl
    this.#armDeadline()

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
    return this.#released || this.#taken || Date.now() >= this.#lease.expiresAt
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  // Whether the lease lapsed with nobody warning about it yet. A lease a renewal found taken, or could not
  // renew, was already warned about.
  get lapsedUnreported(): boolean {
    return !this.#lapseWarned && Date.now() >= this.#lease.expiresAt
  }

  // Reads `lapsedUnreported` for a warning about to be logged, and records that it was, so it is logged once.
  claimLapseWarning(): boolean {
    const unreported = this.lapsedUnreported
    if (unreported) {
      this.#lapseWarned = true
    }

    return unreported
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
    this.#clearDeadline()

    // A renewal already on the wire has to land first, or its write outlives the release and the key stays
    // taken for another lease. Reading the lease afterwards is what makes that safe: it is the one the
    // renewal left behind.
    await this.settled()

    try {
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
    } finally {
      // A lease already lost keeps its loss as the reason.
      if (!this.#controller.signal.aborted) {
        this.#controller.abort(new ErrLockReleased(this.key))
      }
    }
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

  // Leaves the lease standing without its holder: stops renewing and stops watching the deadline, so the lease
  // lapsing later aborts nothing and publishes nothing. What `once` calls when its action returned.
  detach(): void {
    this.#detached = true
    this.stopRenewal()
    this.#clearDeadline()
  }

  // Resolves once no renewal is in flight. A renewal that already reached the backend cannot be called back,
  // so disposal waits for it rather than leaving a write behind.
  settled(): Promise<void> {
    return this.#renewal ?? Promise.resolve()
  }

  // Arms the timer that notices the lease lapsing by the clock when nothing else does. A deadline beyond what
  // `setTimeout` honours is reached in steps.
  #armDeadline(): void {
    this.#clearDeadline()

    const remaining = Math.max(0, this.#lease.expiresAt - Date.now())
    this.#deadline = setTimeout(
      () => {
        this.#deadline = undefined
        if (remaining > MAX_TIMER_DELAY) {
          this.#armDeadline()
        } else if (this.#renewalFailed) {
          // Renewals were failing when the lease ran out: the backend failure is what lost it.
          this.#lose('error', true)
        } else {
          this.#lose('expired', false)
        }
      },
      Math.min(remaining, MAX_TIMER_DELAY),
    )
    // Never the last thing keeping a process alive.
    this.#deadline.unref?.()
  }

  #clearDeadline(): void {
    if (this.#deadline !== undefined) {
      clearTimeout(this.#deadline)
      this.#deadline = undefined
    }
  }

  #schedule(delay?: Duration): void {
    // Whoever stopped renewal did so while this one was in flight, and it is the last.
    if (this.#stopped) {
      return
    }

    // A third of what is left: two renewals may fail before the lease actually lapses.
    delay ??= Math.max(1, Math.floor((this.#lease.expiresAt - Date.now()) / 3))

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

    // A renewal that cannot reach the backend is retried while the lease has more than `storeTimeout` left, and
    // is a lost lease after that, never a crash in whatever the holder is doing. Marked lost here, once the
    // extend channel has settled, so the loss is published after the failure that caused it.
    let renewed: boolean
    try {
      renewed = await traced(
        extendChannel,
        () => this.#extendContext(ttl, true),
        ctx => this.#extendLease(ttl, true, ctx),
      )
    } catch {
      if (this.#givingUp) {
        this.#lose('error', true)
        return
      }

      // The only other path that arms a timer, and it too declines once renewal has been stopped.
      const remaining = this.#lease.expiresAt - Date.now()
      this.#schedule(Math.max(1, Math.min(Math.floor(remaining / 3), this.#host.options.retryDelay)))
      return
    }

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
        late => this.#adoptLate(late, sent, renewal),
        (error: unknown) =>
          this.#host.log.debug(
            { err: error, key: this.key, leaseID: this.leaseID, operation: 'extend' },
            'lock backend failed late',
          ),
      )
    } catch (error) {
      // One warning per lease for a renewal failing: the retries after it are the same incident.
      const fields = { err: error, key: this.key, leaseID: this.leaseID, operation: 'extend' }
      if (renewal && this.#renewalFailed) {
        this.#host.log.debug(fields, 'lock backend failed')
      } else {
        this.#host.log.warn(fields, 'lock backend failed')
      }

      if (renewal) {
        this.#renewalFailed = true
        // Decided here, before a late answer can arrive, so the answer to a renewal that gives up is given back.
        this.#givingUp = this.#lease.expiresAt - Date.now() <= storeTimeout
      }

      if (ctx !== undefined) {
        ctx.outcome = 'error'
      }

      // The lease is left as it was. An explicit extend lets its caller decide; a renewal retries while the lease
      // has time, and marks it lost once this has settled when it does not.
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
    if (renewal) {
      this.#renewalFailed = false
    }

    if (!this.#released && !this.#taken && !this.#detached) {
      this.#armDeadline()
    }

    // Every renewal from here on runs on what an explicit extend asked for. A renewal leaves it alone: one
    // that left before an explicit extend landed would otherwise put the old duration back.
    if (!renewal) {
      this.#ttl = ttl
    }

    if (ctx !== undefined) {
      ctx.outcome = 'extended'
      ctx.expiresAt = next.expiresAt
    }

    this.#host.log.debug({ key: this.key, leaseID: this.leaseID, ttlMs: ttl, renewal }, 'lock extended')

    return true
  }

  // An extension that answered after the lock stopped waiting for it. A lock still held, whose lease nothing has
  // replaced since, carries it from here on. Anything else gives it back, or a backend that rotates the token on
  // extend would keep the key under a token nobody holds, except a lease under the token the lock still holds. A
  // `once` window left standing keeps its answer, so the window is not freed under the next caller. A renewal that
  // gave up gives it back too: it marks the lease lost, possibly only after this runs.
  #adoptLate(late: LockLease | undefined, sent: LockLease, renewal: boolean): void {
    if (late === undefined) {
      return
    }

    if (!(renewal && this.#givingUp) && !this.#released && !this.#taken) {
      if (this.#lease === sent) {
        this.#lease = late
        if (renewal) {
          this.#renewalFailed = false
        }
        if (!this.#detached) {
          this.#armDeadline()
        }
        return
      }

      // A newer answer superseded this one. Under the same token, giving it back would free the key this lock
      // still holds.
      if (late.token === this.#lease.token) {
        return
      }
    }

    this.#host.giveBack(late)
  }

  // The one loss a lease can have: whichever of the deadline, a renewal or shutdown notices first reports it, and
  // the others find it already reported.
  #lose(reason: LostReason, renewal: boolean): void {
    if (this.#taken || this.#detached) {
      return
    }

    this.#taken = true
    this.stopRenewal()
    this.#clearDeadline()

    // A backend failure was already logged as a warning; the loss it caused is the same incident. An expiry with
    // renewal off is the holder's own policy, not an incident.
    const fields = { key: this.key, leaseID: this.leaseID, reason, renewal }
    if (reason === 'taken') {
      this.#lapseWarned = true
      this.#host.log.warn(fields, 'lock lease lost')
    } else {
      if (reason === 'error') {
        this.#lapseWarned = true
      }
      this.#host.log.debug(fields, 'lock lease lost')
    }

    // Published before the abort, so a `lost` listener sees the lease before the holder's handlers run.
    publishLost(() => ({ service: this.#host, ...fields }))
    this.#controller.abort(new ErrLockLost(this.key, reason))
  }

  async #releaseLease(ctx: Writable<ReleaseContext> | undefined): Promise<void> {
    const held = Date.now() - this.acquiredAt
    const lapsed = this.#taken || Date.now() >= this.#lease.expiresAt
    const unreported = this.claimLapseWarning()

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
