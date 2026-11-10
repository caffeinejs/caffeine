import type { Logger } from '@caffeinejs/application/logger'
import type { Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { extendChannel, publishLost, releaseChannel, traced, type Writable } from './_channels.js'
import type { Backend, LockLease } from './backend.js'
import type { DistLock, Lock } from './distlock.js'
import { ErrLockBackendContract, ErrLockBackendTimeout, ErrLockLost, ErrLockReleased } from './errors.js'
import type { ExtendContext, LostReason, ReleaseContext, WithLockContext } from './observability/channels.js'
import { MAX_TIMER_DELAY, type DistLockOptions } from './options.js'
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

  // Counts a backend call a lock started as in flight until it settles, so closing the service can wait for it.
  // Returns the call itself.
  track<T>(call: Promise<T>): Promise<T>
}

// What is wrong with a lease's fencing token, if anything: not a positive safe integer, or, for an extension,
// not the token of the lease it extended. A fencing token numbers an acquisition, not a renewal.
export function fencingViolation(lease: LockLease, extended?: LockLease): ErrLockBackendContract | undefined {
  const token = lease.fencingToken
  if (!Number.isSafeInteger(token) || token <= 0) {
    return new ErrLockBackendContract(
      lease.key,
      errMessage(
        `Cannot accept a lease for "${lease.key}" from the lock backend: fencing token "${String(token)}" is not a positive safe integer`,
      )
        .solutions('Issue a strictly increasing positive integer per key from Backend.tryAcquire')
        .reference('@caffeinejs/distlock', ErrLockBackendContract)
        .build(),
    )
  }

  if (extended !== undefined && token !== extended.fencingToken) {
    return new ErrLockBackendContract(
      lease.key,
      errMessage(
        `Cannot accept an extended lease for "${lease.key}": extend changed the fencing token from "${extended.fencingToken}" to "${token}"`,
      )
        .solutions('Return the fencing token of the lease passed to Backend.extend')
        .reference('@caffeinejs/distlock', ErrLockBackendContract)
        .build(),
    )
  }

  return undefined
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
  // The locks the service holds: this one joins on construction and leaves once it is released, lost or left as a
  // `once` window, so the service's `onDestroy` reaches every lease still in a holder's hands and nothing else.
  readonly #held: Set<HeldLock>

  #ttl: Duration
  #lease: LockLease
  #released = false
  // Set by the one loss a lease can have, whichever of the deadline, a renewal or shutdown notices it first.
  #taken = false
  // Set when that loss was shutdown ending the lease, which is not the lease lapsing.
  #shutdown = false
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
  // Set for a `once` lock: its key is the window, and nothing but its holder lets go of it.
  readonly #window: boolean
  // Explicit extends that timed out and have not answered. Each may have shortened the lease already, so until it
  // answers, the lease this lock knows is not one it can vouch for.
  #unsettled = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #deadline: ReturnType<typeof setTimeout> | undefined
  #renewal: Promise<void> | undefined
  readonly #controller = new AbortController()

  constructor(host: LockHost, lease: LockLease, ttl: Duration, renew: boolean, held: Set<HeldLock>, window = false) {
    this.key = lease.key
    this.leaseID = ++nextLeaseID
    this.acquiredAt = Date.now()
    this.#host = host
    this.#held = held
    this.#lease = lease
    this.#ttl = ttl
    this.#window = window
    this.#armDeadline()
    held.add(this)

    if (renew) {
      this.#schedule()
    }
  }

  get token(): string {
    return this.#lease.token
  }

  get expiresAt(): number {
    return this.#lease.expiresAt
  }

  get fencingToken(): number {
    return this.#lease.fencingToken
  }

  get lost(): boolean {
    return this.#released || this.#taken || this.#unsettled > 0 || Date.now() >= this.#lease.expiresAt
  }

  // Whether the lease ran out from under its holder: lost, or past its expiry. A lease shutdown ended was not.
  get lapsed(): boolean {
    return (this.#taken && !this.#shutdown) || Date.now() >= this.#lease.expiresAt
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

    return this.#host.track(
      traced(
        extendChannel,
        () => this.#extendContext(span, false),
        ctx => this.#extendLease(span, false, ctx),
      ),
    )
  }

  release(): Promise<void> {
    if (this.#released) {
      return Promise.resolve()
    }

    this.#released = true
    this.#held.delete(this)
    this.stopRenewal()
    this.#clearDeadline()

    // Counted from here, not from the backend call: a holder that releases as its signal aborts must be waited for
    // by a shutdown that is about to look whether anything is still in flight.
    return this.#host.track(this.#release())
  }

  async #release(): Promise<void> {
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

  // Stops renewing without touching the key.
  stopRenewal(): void {
    this.#stopped = true

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  // Leaves the lease standing without its holder: stops renewing and stops watching the deadline, so the lease
  // lapsing later aborts nothing and publishes nothing. What `once` calls when its action returned.
  detach(): void {
    this.#detached = true
    this.#held.delete(this)
    this.stopRenewal()
    this.#clearDeadline()
  }

  // Ends a lease still in its holder's hands because the service is closing: renewal stops and the signal aborts
  // with reason `shutdown`. The key is not released: the holder releases it on its own path once it has stopped,
  // or it lapses. Says whether this ended the lease, rather than finding it already over.
  endForShutdown(): boolean {
    if (this.#released || this.#taken || this.#detached) {
      return false
    }

    this.#shutdown = true
    this.#lose('shutdown', false)
    return true
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
      this.#renewal = this.#host.track(this.#renew()).finally(() => {
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
      // until the answer arrives, the lock reads as lost. A renewal retries, or marks the lease lost, on its own.
      if (!renewal && error instanceof ErrLockBackendTimeout && !call.answered) {
        call.abandoned = true
        this.#unsettled += 1
      }

      this.#extendFailed(error, renewal, ctx)
      throw error
    }

    const violation = next === undefined ? undefined : fencingViolation(next, sent)
    if (violation !== undefined) {
      this.#refuseExtended(violation, next!, renewal, ctx)
      throw violation
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
    this.#reconcile(next, sent, renewal)

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

  // Records an extension that failed. The lease is left as it was: an explicit extend lets its caller decide; a
  // renewal retries while the lease has time, and marks it lost once the channel has settled when it does not.
  #extendFailed(error: unknown, renewal: boolean, ctx: Writable<ExtendContext> | undefined): void {
    const { storeTimeout } = this.#host.options

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
  }

  // A backend that changed the token breaks fencing for every write after this one: the lease is given back and
  // the lock lost rather than carried on under a number the resource cannot trust.
  #refuseExtended(
    violation: ErrLockBackendContract,
    next: LockLease,
    renewal: boolean,
    ctx: Writable<ExtendContext> | undefined,
  ): void {
    this.#host.log.warn(
      { err: violation, key: this.key, leaseID: this.leaseID, operation: 'extend' },
      'lock backend failed',
    )
    this.#host.giveBack(next)

    if (ctx !== undefined) {
      ctx.outcome = 'error'
    }

    if (renewal) {
      // Not retried: `#renew` marks the lease lost once the channel has settled.
      this.#givingUp = true
    } else {
      this.#lose('error', false)
    }
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
  // A renewal that gave up marks the lease lost, possibly only after this runs, so its lease is given back. After
  // shutdown the service sends nothing, so it lapses instead.
  //
  // A renewal still retrying, or an explicit extend, on a lock still held is reconciled with the lease the lock
  // carries when it was sent on that lease or answered under its token. Anything else gives the lease back, or a
  // backend that rotates the token on extend would keep the key under a token nobody holds.
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
      this.#reconcile(late, sent, renewal)
      return
    }

    if (renewal && this.#givingUp) {
      this.#host.giveBack(late)
      return
    }

    if (held && (this.#lease === sent || late.token === this.#lease.token)) {
      this.#reconcile(late, sent, renewal)
      return
    }

    this.#host.giveBack(late)
  }

  // Takes an extension's answer, on time or late, unless a newer one already replaced the lease it was sent with.
  // Two extends under one token may land in either order whatever order they answer in, so between their answers
  // the earlier expiry is the one the lock can rely on. An answer that renumbered the lease is refused as an on-time
  // one is: the lease cannot be trusted, so it is given back and the lock lost.
  #reconcile(next: LockLease, sent: LockLease, renewal: boolean): void {
    if (this.#lease !== sent && (next.token !== this.#lease.token || next.expiresAt >= this.#lease.expiresAt)) {
      return
    }

    const violation = fencingViolation(next, this.#lease)
    if (violation !== undefined) {
      this.#host.log.warn(
        { err: violation, key: this.key, leaseID: this.leaseID, operation: 'extend' },
        'lock backend failed late',
      )
      this.#host.giveBack(next)
      this.#lose('error', renewal)
      return
    }

    this.#lease = next
    if (renewal) {
      this.#renewalFailed = false
    }
    if (!this.#released && !this.#taken && !this.#detached) {
      this.#armDeadline()
    }
  }

  // The one loss a lease can have: whichever of the deadline, a renewal or shutdown notices first reports it, and
  // the others find it already reported.
  #lose(reason: LostReason, renewal: boolean): void {
    if (this.#taken || this.#detached) {
      return
    }

    this.#taken = true
    this.#held.delete(this)
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
    const lapsed = this.lapsed
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
