import type { Logger } from '@caffeinejs/application/logger'
import type { Duration } from '@caffeinejs/std/duration'

import { extendChannel, publishLost, releaseChannel, traced, type Writable } from './_channels.js'
import type { Backend, LockLease } from './backend.js'
import type { DistLock, Lock } from './distlock.js'
import { ErrLockLost, ErrLockReleased } from './errors.js'
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
}

// A write whose effect on the key is not known yet.
interface PossibleWrite {
  sentAt: number
  ttl: Duration
  shortening: boolean
  settled?: number
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
  #leaseVersion = 0
  // The ttl the write behind `#lease` asked for. A write still unanswered can only end the lease sooner when it asks
  // for less: landing later with as much or more, it pushes the expiry out.
  #leaseTTL: Duration
  #leaseReplies: Array<{ version: number; lease: LockLease; ttl: Duration }> | undefined
  #pendingExtends = 0
  #refusedRenewal: boolean | undefined
  readonly #extending = new Set<Promise<void>>()
  readonly #waitingExtends = new Map<object, number>()
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
  // The pause before the next renewal when the last one failed and is retried.
  #retryIn: Duration | undefined
  // Set for a `once` lock: its key is the window, and nothing but its holder lets go of it.
  readonly #window: boolean
  // Shortening extensions and abandoned explicit extensions whose writes have not been confirmed.
  #unsettled = 0
  // Each extension under the current token that may still land or may have landed unseen: when it was sent, the ttl
  // it asked for, and whether it was shorter than what was left of the lease then. One that looked longer when it
  // left can land after a longer one answered, so the deadline also watches every one that asks for less than the
  // write behind the lease. A write that failed with its outcome unknown stays, with `settled` set to the number of
  // writes sent by then, until a write sent after it succeeds and so landed after it.
  readonly #unanswered = new Map<object, PossibleWrite>()
  #writes = 0
  // The reason the signal aborts with, set by the loss before anyone is told, so a release a `lost` listener
  // makes keeps it.
  #lossReason: ErrLockLost | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #deadline: ReturnType<typeof setTimeout> | undefined
  #renewal: Promise<void> | undefined
  readonly #controller = new AbortController()

  constructor(host: LockHost, lease: LockLease, ttl: Duration, renewing: Set<HeldLock> | undefined, window = false) {
    this.key = lease.key
    this.leaseID = ++nextLeaseID
    this.acquiredAt = Date.now()
    this.#host = host
    this.#renewing = renewing
    this.#lease = lease
    this.#ttl = ttl
    this.#leaseTTL = ttl
    this.#window = window
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
    return this.#released || this.#taken || this.#ownershipUncertain() || Date.now() >= this.#lease.expiresAt
  }

  #ownershipUncertain(): boolean {
    if (this.#refusedRenewal !== undefined || this.#unsettled > 0) {
      return true
    }

    if (this.#waitingExtends.size > 0) {
      const now = performance.now()
      for (const deadline of this.#waitingExtends.values()) {
        // A blocked event loop can delay the timeout callback past the backend's expiry.
        if (now >= deadline) {
          return true
        }
      }
    }
    return false
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
    if (this.#released || this.#taken || this.#detached) {
      return false
    }

    const span = ttl ?? this.#ttl

    const completion = Promise.withResolvers<void>()
    this.#extending.add(completion.promise)
    try {
      return await traced(
        extendChannel,
        () => this.#extendContext(span, false),
        ctx => this.#extendLease(span, false, ctx),
      )
    } finally {
      this.#extending.delete(completion.promise)
      completion.resolve()
    }
  }

  async release(): Promise<void> {
    // A `once` window left standing is no longer the holder's to end.
    if (this.#released || this.#detached) {
      return
    }

    // Claimed before an overdue loss is published, so a `lost` listener that releases finds it released.
    this.#released = true
    this.#expireIfDue()
    this.stopRenewal()
    this.#clearDeadline()
    // The holder lets go here, not once the backend answers: the key may change hands as soon as the release
    // lands, and work bound to the signal must not outlive that. A lease already lost keeps its loss as the reason.
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(this.#lossReason ?? new ErrLockReleased(this.key))
    }

    // Wait for bounded extensions already on the wire before choosing the token to release. A backend that
    // rotates it after the deadline hands it back through the late callback.
    await Promise.all([this.settled(), ...this.#extending])

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

  // Leaves the lease standing without its holder: stops renewing and stops watching the deadline, so the lease
  // lapsing later aborts nothing and publishes nothing. What `once` calls when its action returned.
  detach(): void {
    this.#expireIfDue()
    this.#detached = true
    this.stopRenewal()
    this.#clearDeadline()
  }

  // Resolves once no renewal is in flight. A renewal that already reached the backend cannot be called back,
  // so disposal waits for it rather than leaving a write behind.
  settled(): Promise<void> {
    return this.#renewal ?? Promise.resolve()
  }

  // Arms the timer that notices the lease lapsing by the clock when nothing else does: at its expiry, or earlier
  // when an extension still unanswered could end it first. A deadline beyond what `setTimeout` honours is reached
  // in steps.
  #armDeadline(): void {
    this.#clearDeadline()

    const remaining = Math.max(0, this.#earliestExpiry() - Date.now())
    this.#deadline = setTimeout(
      () => {
        this.#deadline = undefined
        if (remaining > MAX_TIMER_DELAY) {
          this.#armDeadline()
        } else {
          this.#expire()
        }
      },
      Math.min(remaining, MAX_TIMER_DELAY),
    )
    // Never the last thing keeping a process alive.
    this.#deadline.unref?.()
  }

  #expire(): void {
    if (this.#renewalFailed) {
      // Renewals were failing when the lease ran out: the backend failure is what lost it.
      this.#lose('error', true)
    } else {
      this.#lose('expired', false)
    }
  }

  // Reports a deadline that passed while a callback held the event loop, before release or `once` clears its timer:
  // the lease ran out while the holder still had it.
  #expireIfDue(): void {
    if (this.#deadline !== undefined && Date.now() >= this.#earliestExpiry()) {
      this.#clearDeadline()
      this.#expire()
    }
  }

  // The earliest the lease can end: its expiry, or `ttl` after an unanswered shorter write was sent, since the
  // backend cannot apply it earlier.
  #earliestExpiry(): number {
    let earliest = this.#lease.expiresAt
    for (const { sentAt, ttl, shortening } of this.#unanswered.values()) {
      if (shortening || ttl < this.#leaseTTL) {
        earliest = Math.min(earliest, sentAt + ttl)
      }
    }
    return earliest
  }

  #clearDeadline(): void {
    if (this.#deadline !== undefined) {
      clearTimeout(this.#deadline)
      this.#deadline = undefined
    }
  }

  // Re-arms the deadline after what it watches changed, while there is still a holder to tell.
  #rearmDeadline(): void {
    if (!this.#released && !this.#taken && !this.#detached) {
      this.#armDeadline()
    }
  }

  #schedule(): void {
    if (
      this.#stopped ||
      this.#renewing === undefined ||
      this.#timer !== undefined ||
      this.#renewal !== undefined ||
      this.#refusedRenewal !== undefined
    ) {
      return
    }

    // A lease already past its expiry is the deadline's to report: its timer fires first and stops renewal.
    const remaining = this.expiresAt - Date.now()
    const retryIn = this.#retryIn
    this.#retryIn = undefined

    // A third of what is left: two renewals may fail before the lease actually lapses.
    // A failed renewal retries sooner, but never later than that.
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(1, Math.min(Math.floor(remaining / 3), retryIn ?? Infinity)))

    this.#timer = setTimeout(() => {
      // Register the renewal before a backend can synchronously call back into release().
      this.#renewal = Promise.resolve()
        .then(() => this.#renew())
        .finally(() => {
          this.#renewal = undefined
          this.#schedule()
        })
    }, delay)
    // Never the last thing keeping a process alive.
    this.#timer.unref?.()
  }

  async #renew(): Promise<void> {
    this.#timer = undefined

    if (this.#stopped) {
      return
    }

    const ttl = this.#ttl
    const token = this.token

    // A renewal that cannot reach the backend is retried while the lease has more than `storeTimeout` left, and
    // is a lost lease after that, never a crash in whatever the holder is doing. Marked lost here, once the
    // extend channel has settled, so the loss is published after the failure that caused it.
    try {
      await traced(
        extendChannel,
        () => this.#extendContext(ttl, true),
        ctx => this.#extendLease(ttl, true, ctx),
      )
    } catch {
      // A late answer that moved the lease on while this one failed leaves nothing to give up on.
      if (token !== this.token) {
        return
      }

      if (this.#givingUp) {
        this.#lose('error', true)
        return
      }

      this.#retryIn = this.#host.options.retryDelay
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
    if (this.#released || this.#taken || this.#refusedRenewal !== undefined) {
      if (ctx !== undefined) {
        ctx.outcome = 'lost'
      }
      return false
    }

    const { storeTimeout } = this.#host.options
    const remaining = Math.max(1, this.#lease.expiresAt - Date.now())
    const timeout = Math.min(storeTimeout, remaining)
    const sent = this.#lease
    const version = this.#leaseVersion
    // A shortening write can expire the lease before its reply, even inside the store deadline.
    this.#writes += 1
    const call = { answered: false, uncertain: ttl < remaining, seq: this.#writes }
    this.#waitingExtends.set(call, performance.now() + timeout)
    this.#pendingExtends += 1
    this.#unanswered.set(call, { sentAt: Date.now(), ttl, shortening: call.uncertain })
    if (call.uncertain) {
      this.#unsettled += 1
      this.#armDeadline()
    }
    // The renewal attempt this call belongs to, so a late answer waits for that attempt's decision and no later one.
    const attempt = renewal ? this.#renewal : undefined
    let storeSignal: AbortSignal | undefined

    let next: LockLease | undefined
    try {
      next = await boundedCall(
        {
          operation: 'extend',
          key: this.key,
          timeout,
          bound: storeTimeout <= remaining ? 'storeTimeout' : 'ttl',
        },
        signal => {
          storeSignal = signal
          return this.#host.backend.extend(sent, ttl, signal)
        },
        async late => {
          // A late renewal must see its own attempt's loss decision, including when its reply would rotate the
          // token. A retry that attempt left behind is not waited for: the reply supersedes the token it carries.
          await attempt
          this.#answered(call, sent.token)
          this.#adoptLate(late, sent, ttl, version, call.seq, renewal)
          this.#finishRefusal()
        },
        (error: unknown, cancelled: boolean) => {
          this.#answered(call, sent.token, !cancelled)
          this.#host.log.debug(
            { err: error, key: this.key, leaseID: this.leaseID, operation: 'extend' },
            'lock backend failed late',
          )

          // A cancelled extension never took effect, so the lease it was sent on stands. After any other failure
          // whether it took effect is unknown for good, so the lease is no longer one to rely on.
          if (!cancelled && !renewal && !this.#released && !this.#taken && sent.token === this.token) {
            this.#lose('error', false)
          }
          this.#finishRefusal()
        },
      )
    } catch (error) {
      // The backend may have applied an extension it did not answer in time, and a shorter ttl shortens the lease:
      // until the answer arrives, the lock reads as lost. A renewal that timed out is marked lost outright.
      this.#waitingExtends.delete(call)
      if (storeSignal?.aborted === true && error === storeSignal.reason) {
        if (!call.answered && !call.uncertain && sent.token === this.token) {
          call.uncertain = true
          this.#unsettled += 1
        }
      } else {
        // A backend that lost its connection may have applied the write before it could answer.
        this.#answered(call, sent.token, true)
        this.#finishRefusal()
      }

      this.#extendFailed(error, renewal, ctx)
      throw error
    }

    this.#answered(call, sent.token)

    if (next === undefined) {
      if (ctx !== undefined) {
        ctx.outcome = 'lost'
      }

      this.#refuse(sent.token, renewal)
      return false
    }

    // Taken even when this lock was released or stopped mid-flight: a release waiting behind this
    // renewal has to send the lease the renewal left behind, not the one it superseded.
    const current = this.#reconcile(next, sent, ttl, version, call.seq, renewal)
    this.#finishRefusal()

    // Every renewal from here on runs on what an explicit extend asked for. A renewal leaves it alone: one
    // that left before an explicit extend landed would otherwise put the old duration back.
    if (!renewal && current) {
      this.#ttl = ttl
    }

    if (this.#taken || this.#ownershipUncertain() || this.expiresAt <= Date.now()) {
      if (ctx !== undefined) {
        ctx.outcome = 'lost'
      }
      return false
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

  // Records that an extension completed. Its write's bound goes, unless it failed with its outcome unknown. A lease
  // that ran out before the completion could run is reported first: nothing answering afterwards revives it.
  #answered(call: { answered: boolean; uncertain: boolean }, token: string, unknown = false): void {
    this.#expireIfDue()
    this.#waitingExtends.delete(call)
    const write = this.#unanswered.get(call)
    if (write !== undefined) {
      this.#unanswered.delete(call)
      if (unknown) {
        this.#keepUnknown(write)
      }
      this.#rearmDeadline()
    }
    if (!call.answered && token === this.token) {
      this.#pendingExtends -= 1
      if (call.uncertain) {
        this.#unsettled -= 1
      }
    }
    call.answered = true
  }

  // Keeps the bound of a write that failed without saying whether it landed, unless one already kept bounds the
  // lease at least as early in every case, as an earlier failed renewal does a later one.
  #keepUnknown(write: PossibleWrite): void {
    for (const kept of this.#unanswered.values()) {
      if (
        kept.settled !== undefined &&
        kept.ttl <= write.ttl &&
        kept.sentAt <= write.sentAt &&
        (kept.shortening || !write.shortening)
      ) {
        return
      }
    }

    this.#unanswered.set({}, { ...write, settled: this.#writes })
  }

  #refuse(token: string, renewal: boolean): void {
    if (token !== this.token || this.#taken || this.#released) {
      return
    }

    // A concurrent extension could have rotated the token. Until those replies arrive, the old token is unsafe,
    // but a refusal of it is not yet evidence the holder lost the key.
    this.#refusedRenewal ??= renewal
    this.#finishRefusal()
  }

  #finishRefusal(): void {
    if (this.#refusedRenewal !== undefined && this.#pendingExtends === 0) {
      const renewal = this.#refusedRenewal
      this.#refusedRenewal = undefined
      if (!this.#taken && !this.#released) {
        this.#lose('taken', renewal)
      }
    }
    this.#schedule()
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
  // A renewal still retrying, or an explicit extend, under the current token is reconciled while the lock is still
  // held. Other replies are given back, so a backend that rotates the token cannot leave the key under a token
  // nobody holds.
  #adoptLate(
    late: LockLease | undefined,
    sent: LockLease,
    ttl: Duration,
    version: number,
    seq: number,
    renewal: boolean,
  ): void {
    const held = !this.#released && !this.#taken

    if (late === undefined) {
      // The backend refused the token the call carried. That is news only while the lock still carries it: a newer
      // extend may have moved the key to another. A renewal that gave up already reported the loss.
      this.#refuse(sent.token, renewal)
      return
    }

    if (this.#window && !this.#released) {
      this.#reconcile(late, sent, ttl, version, seq, renewal)
      return
    }

    if (renewal && this.#givingUp) {
      this.#host.giveBack(late)
      return
    }

    if (held && this.#reconcile(late, sent, ttl, version, seq, renewal)) {
      return
    }

    this.#host.giveBack(late)
  }

  // A successful rotation supersedes every write on the old token. For same-token writes, only the replies
  // already known when this call was sent are definitely older than its write.
  #reconcile(next: LockLease, sent: LockLease, ttl: Duration, version: number, seq: number, renewal: boolean): boolean {
    if (sent.token !== this.token) {
      return false
    }

    // This write landed after every failed one settled before it was sent: whatever those did, it overrode.
    for (const [key, write] of this.#unanswered) {
      if (write.settled !== undefined && write.settled < seq) {
        this.#unanswered.delete(key)
      }
    }

    const previousExpiry = this.expiresAt
    const previousVersion = this.#leaseVersion
    this.#leaseVersion += 1
    if (next.token !== sent.token) {
      this.#pendingExtends = 0
      this.#waitingExtends.clear()
      this.#unsettled = 0
      this.#refusedRenewal = undefined
      this.#leaseReplies = undefined
      this.#unanswered.clear()
      this.#lease = next
      this.#leaseTTL = ttl
    } else if (version === previousVersion) {
      this.#leaseReplies = undefined
      this.#lease = next
      this.#leaseTTL = ttl
    } else {
      const replies = this.#leaseReplies ?? [{ version: previousVersion, lease: this.#lease, ttl: this.#leaseTTL }]
      const possibleLatest = replies.filter(reply => reply.version > version)
      possibleLatest.push({ version: this.#leaseVersion, lease: next, ttl })
      this.#leaseReplies = possibleLatest

      // Whichever of these landed last sets the expiry: the lease is the earliest of them, and an unanswered write
      // counts against it unless it asks for at least the longest of them.
      this.#lease = next
      this.#leaseTTL = ttl
      for (const reply of possibleLatest) {
        if (reply.lease.expiresAt < this.expiresAt) {
          this.#lease = reply.lease
        }
        this.#leaseTTL = Math.max(this.#leaseTTL, reply.ttl)
      }
    }

    if (this.#timer !== undefined && (this.expiresAt < previousExpiry || previousExpiry <= Date.now())) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (renewal) {
      this.#renewalFailed = false
    }
    this.#rearmDeadline()
    this.#schedule()
    return true
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

    // Published before the abort, so a `lost` listener sees the lease before the holder's handlers run. A release
    // that listener makes aborts with this reason too.
    this.#lossReason = new ErrLockLost(this.key, reason)
    publishLost(() => ({ service: this.#host, ...fields }))
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(this.#lossReason)
    }
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
