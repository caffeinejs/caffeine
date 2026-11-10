import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { lift, mark } from '../compose.js'
import { disposable } from '../dispose.js'
import { Emitter } from '../emitter.js'
import { ErrCallRefused, refusal } from '../errors.js'
import { Options } from '../options.js'
import { type CallContext, type Operation, restoreWaitingCall, type Wrapper } from '../policy.js'
import { clampDelay, type Clock } from '../timers.js'
import { type Waiter, Waiters } from '../waiters.js'

/**
 * A rate limiter refused the call: no permit was left in this period, and the next one it could have had was further
 * away than it was allowed to wait. The operation did not run; `retryAfter` is how long until that permit.
 */
export class ErrRateLimitExceeded extends ErrCallRefused {
  /** The name of the rate limiter that refused the call. */
  readonly rateLimiter: string
  declare readonly retryAfter: Duration

  /** `disposed` says the call waited for a permit and the wait ended because the rate limiter was disposed. */
  constructor(
    rateLimiter: string,
    limitForPeriod: number,
    limitRefreshPeriod: Duration,
    retryAfter: Duration,
    disposed = false,
  ) {
    super(
      exceededMessage(rateLimiter, limitForPeriod, limitRefreshPeriod, disposed),
      'ERR_RATE_LIMIT_EXCEEDED',
      retryAfter,
    )
    this.name = 'ErrRateLimitExceeded'
    this.rateLimiter = rateLimiter
  }
}

// Built once rather than per refusal: refusals come in bulk once a quota is spent.
const footer = errMessage('').reference('@caffeinejs/resilience', ErrRateLimitExceeded).build()

function exceededMessage(
  rateLimiter: string,
  limitForPeriod: number,
  limitRefreshPeriod: Duration,
  disposed: boolean,
): string {
  const calls = limitForPeriod === 1 ? 'call' : 'calls'
  const reason = disposed
    ? 'rate limiter was disposed while the call waited for a permit'
    : `rate limit of ${limitForPeriod} ${calls} per ${formatDuration(limitRefreshPeriod)} reached`
  return `Cannot call "${rateLimiter}": ${reason}${footer}`
}

export interface RateLimiterOptions {
  /** Names the rate limiter in errors, events and metrics. */
  name: string
  /** Calls that may start in each period. Required. */
  limitForPeriod: number
  /** The length of a period. Required. */
  limitRefreshPeriod: Duration
  /** How long a call may wait for a permit of a later period. `0`, the default, refuses a call that finds none. */
  maxWaitDuration?: Duration
  /** Whether a refused call's {@link ErrRateLimitExceeded} captures a stack trace. Off by default. */
  captureStackTrace?: boolean
  /** Where the rate limiter reads the time and sets its timer. Defaults to the runtime's. */
  clock?: Clock
}

export interface RateLimiterMetrics {
  /** Permits left in the current period. */
  readonly availablePermissions: number
  readonly waitingCalls: number
  /** Every call refused since the rate limiter was created. */
  readonly rejectedCalls: number
}

export interface RateLimiterEvents {
  /** A call got a permit. `waited` is how long it waited for it, `0` when one was left. */
  permitted: { readonly name: string; readonly waited: Duration }
  rejected: { readonly name: string; readonly retryAfter: Duration }
}

interface WaitingCall<T, I> extends Waiter {
  readonly ctx: CallContext
  readonly inner: Operation<T, I>
  readonly input: I
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  readonly since: number
  // The period whose permit this call reserved.
  cycle: number
  onAbort: (() => void) | undefined
}

/**
 * Limits how often calls start: at most `limitForPeriod` in each period of `limitRefreshPeriod`, periods counted
 * from when the rate limiter was created.
 *
 * A call that finds no permit left reserves one of a later period when it would get it within `maxWaitDuration`,
 * and waits for it; calls are served in the order they reserved. Otherwise it is refused with
 * {@link ErrRateLimitExceeded}, whose `retryAfter` says when its permit would have come. A waiting call whose signal
 * aborts leaves the line and rejects with the abort reason; the last call in line gives its permit back, any other
 * spends it.
 *
 * Permits are counted per period reserved. On an event loop too busy to start a waiting call in its period, the call
 * starts later on the permit it reserved, ahead of any call that arrived after it.
 *
 * The limit holds in this process only: replicas that each allow 100 calls a second allow 100 times as many between
 * them.
 */
export class RateLimiter implements Wrapper {
  declare [Symbol.dispose]: () => void
  readonly #name: string
  #limitForPeriod: number
  readonly #limitRefreshPeriod: Duration
  #maxWaitMs: number
  readonly #captureStackTrace: boolean
  readonly #clock: Clock
  readonly #origin: number
  readonly #queue = new Waiters<WaitingCall<any, any>>()
  readonly #emitter = new Emitter<RateLimiterEvents>()
  #cycle = 0
  // Permits left in the current period; below zero, the permits of later periods that waiting calls reserved.
  #permits: number
  #rejected = 0
  #timer: unknown
  #disposed = false

  constructor(options: RateLimiterOptions) {
    const o = new Options('rate limiter', options)
    this.#name = o.name
    this.#limitForPeriod = o.integer(
      'limitForPeriod',
      options.limitForPeriod,
      1,
      'Pass the calls the dependency allows per period, such as limitForPeriod: 100',
    )
    this.#limitRefreshPeriod = o.positiveDuration(
      'limitRefreshPeriod',
      options.limitRefreshPeriod,
      'Pass the length of the quota period, such as limitRefreshPeriod: 1 * Second',
    )
    const maxWaitDuration = o.duration('maxWaitDuration', options.maxWaitDuration ?? 0, 0)
    this.#captureStackTrace = o.boolean('captureStackTrace', options.captureStackTrace, false)
    this.#clock = o.clock(options.clock)
    this.#maxWaitMs = clampDelay(maxWaitDuration, `the wait of rate limiter "${o.name}"`)
    this.#origin = this.#clock.now()
    this.#permits = this.#limitForPeriod
  }

  get name(): string {
    return this.#name
  }

  /** How long a call may wait for a permit, as `changeMaxWaitDuration` last set it. */
  get maxWaitDuration(): Duration {
    return this.#maxWaitMs
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof RateLimiterEvents>(type: K, listener: (event: RateLimiterEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  metrics(): RateLimiterMetrics {
    this.#refresh(this.#clock.now())
    return {
      availablePermissions: Math.max(this.#permits, 0),
      waitingCalls: this.#queue.size,
      rejectedCalls: this.#rejected,
    }
  }

  /**
   * Changes how many calls may start in each period, from the next period on: the current one keeps the permits it
   * has left. The calls waiting for a permit line up again under the new limit, in the order they came, and one whose
   * permit now lies further away than it may wait is refused with {@link ErrRateLimitExceeded}.
   *
   * @throws {@link ErrInvalidOption} when `limitForPeriod` is not an integer of at least 1.
   */
  changeLimitForPeriod(limitForPeriod: number): void {
    const limit = new Options('rate limiter', { name: this.#name }, 'change').integer(
      'limitForPeriod',
      limitForPeriod,
      1,
    )
    const now = this.#clock.now()
    this.#catchUp(now)
    this.#limitForPeriod = limit

    // Every call still waiting reserved a later period, so the current one has no permit left. Lined up again, the
    // calls fill the coming periods in order; a call that left the line no longer holds a place.
    const refused: Array<[WaitingCall<unknown, unknown>, Duration]> = []
    let kept = 0
    let call = this.#queue.first
    while (call !== undefined) {
      const next = call.next as WaitingCall<unknown, unknown> | undefined
      const cycle = this.#cycle + 1 + Math.floor(kept / limit)
      const at = this.#origin + cycle * this.#limitRefreshPeriod
      if (at - call.since > this.#maxWaitMs) {
        this.#leave(call)
        refused.push([call, at - now])
      } else {
        call.cycle = cycle
        kept++
      }
      call = next
    }
    // Below zero, the current period has no permit left and the rest are reservations, which are now the calls kept.
    if (this.#permits <= 0) {
      this.#permits = -kept
    }
    this.#schedule()

    // Refused once the line is whole again, so a listener that calls back in finds it so.
    for (const [refusedCall, retryAfter] of refused) {
      this.#refuse(refusedCall, retryAfter, false)
    }
  }

  /**
   * Changes how long a call may wait for a permit. It applies to the calls that arrive from now on: a call already
   * waiting keeps the permit it reserved.
   *
   * The annotations compare the wait with a time limiter around the rate limiter once, at start-up. Raised to that
   * limit or past it, a waiting call times out instead of being refused.
   *
   * @throws {@link ErrInvalidOption} when `maxWaitDuration` is not a finite Duration of at least 0s.
   */
  changeMaxWaitDuration(maxWaitDuration: Duration): void {
    const o = new Options('rate limiter', { name: this.#name }, 'change')
    this.#maxWaitMs = clampDelay(
      o.duration('maxWaitDuration', maxWaitDuration, 0),
      `the wait of rate limiter "${this.#name}"`,
    )
  }

  /**
   * Refuses every call waiting for a permit now, with {@link ErrRateLimitExceeded}, and from then on refuses a call at
   * once where it would wait, so no wait holds a shutdown. A call that finds a permit left still starts. The
   * `[Symbol.dispose]` alias does the same.
   */
  dispose(): void {
    this.#disposed = true
    const now = this.#clock.now()
    // A call whose period came while its timer was late holds its permit: it starts rather than being refused.
    this.#catchUp(now)

    const refused: Array<WaitingCall<unknown, unknown>> = []
    for (let call = this.#queue.first; call !== undefined; call = this.#queue.first) {
      this.#leave(call)
      refused.push(call)
    }
    // Nobody holds a later period any more, and the current one had no permit left while anybody did.
    if (this.#permits < 0) {
      this.#permits = 0
    }
    this.#schedule()

    // Refused once the line is empty, so a listener that calls back in finds it so.
    for (const call of refused) {
      this.#refuse(call, this.#origin + call.cycle * this.#limitRefreshPeriod - now, true)
    }
  }

  wrap<T, I = void>(op: Operation<T, I>): Operation<T, I> {
    const inner = lift(op)
    return mark((ctx, input) => {
      const now = this.#clock.now()
      this.#refresh(now)
      // A timer that fired late, on a busy event loop, still owes the calls whose period has come their turn first.
      const first = this.#queue.first
      if (first !== undefined && first.cycle <= this.#cycle) {
        this.#wake()
      }

      if (this.#permits > 0) {
        this.#permits--
        if (this.#emitter.has('permitted')) {
          this.#emitter.emit('permitted', { name: this.#name, waited: 0 })
        }
        return inner(ctx, input)
      }

      // The permits of the coming periods go, in order, to the calls that reserved them; this call would get the next.
      const cycle = this.#cycle + Math.ceil((1 - this.#permits) / this.#limitForPeriod)
      const wait = this.#origin + cycle * this.#limitRefreshPeriod - now
      if (wait > this.#maxWaitMs || this.#disposed) {
        this.#rejected++
        if (this.#emitter.has('rejected')) {
          this.#emitter.emit('rejected', { name: this.#name, retryAfter: wait })
        }
        // Returned, not thrown: throwing costs more than the rest of the refusal together.
        return Promise.reject(this.#exceeded(wait))
      }

      const signal = ctx.signal
      if (signal !== undefined && signal.aborted) {
        return Promise.reject(signal.reason)
      }

      this.#permits--
      return new Promise<T>((resolve, reject) => {
        const call: WaitingCall<T, I> = {
          ctx,
          inner,
          input,
          resolve,
          reject,
          since: now,
          cycle,
          onAbort: undefined,
          prev: undefined,
          next: undefined,
          queued: false,
        }
        this.#queue.push(call)
        if (this.#queue.first === call) {
          this.#schedule()
        }

        if (signal !== undefined) {
          call.onAbort = () => {
            const head = this.#queue.first === call
            const tail = this.#queue.last === call
            if (this.#queue.remove(call)) {
              // The last call in line gives its permit back: nobody reserved after it. Any other spends it, because
              // the calls after it reserved by count, and handing it on would put two calls in a period with room
              // for one.
              if (tail) {
                this.#permits++
              }
              if (head) {
                this.#schedule()
              }
              reject(signal.reason)
            }
          }
          signal.addEventListener('abort', call.onAbort, { once: true })
        }
      })
    })
  }

  // The refusal, with a stack trace only when asked for one.
  #exceeded(retryAfter: Duration, disposed = false): ErrRateLimitExceeded {
    const limit = this.#limitForPeriod
    if (this.#captureStackTrace) {
      return new ErrRateLimitExceeded(this.#name, limit, this.#limitRefreshPeriod, retryAfter, disposed)
    }
    return refusal(ErrRateLimitExceeded, exceededMessage(this.#name, limit, this.#limitRefreshPeriod, disposed), {
      code: 'ERR_RATE_LIMIT_EXCEEDED',
      name: 'ErrRateLimitExceeded',
      retryAfter,
      rateLimiter: this.#name,
    })
  }

  // Moves to the period `now` falls in and starts the calls whose period has come, as a call arriving now would.
  #catchUp(now: number): void {
    this.#refresh(now)
    const first = this.#queue.first
    if (first !== undefined && first.cycle <= this.#cycle) {
      this.#wake()
    }
  }

  // Takes a waiting call out of line and drops its abort listener.
  #leave(call: WaitingCall<any, any>): void {
    this.#queue.remove(call)
    if (call.onAbort !== undefined) {
      call.ctx.signal?.removeEventListener('abort', call.onAbort)
    }
  }

  // Refuses a call that was waiting, in its caller's context: its permit lies `retryAfter` away.
  #refuse(call: WaitingCall<any, any>, retryAfter: Duration, disposed: boolean): void {
    this.#rejected++
    const restore = call.ctx.restore
    if (restore === undefined) {
      this.#reject(call, retryAfter, disposed)
    } else {
      restoreWaitingCall(call.ctx, restore, () => this.#reject(call, retryAfter, disposed), call.reject)
    }
  }

  #reject(call: WaitingCall<any, any>, retryAfter: Duration, disposed: boolean): void {
    if (this.#emitter.has('rejected')) {
      this.#emitter.emit('rejected', { name: this.#name, retryAfter })
    }
    call.reject(this.#exceeded(retryAfter, disposed))
  }

  // Moves to the period `now` falls in, granting a full set of permits per period passed, less what was reserved.
  #refresh(now: number): void {
    const cycle = Math.floor((now - this.#origin) / this.#limitRefreshPeriod)
    if (cycle > this.#cycle) {
      this.#permits = Math.min(this.#limitForPeriod, this.#permits + (cycle - this.#cycle) * this.#limitForPeriod)
      this.#cycle = cycle
    }
  }

  // One timer, for the period the first waiting call reserved, and none while nobody waits. Not unref'd: a call
  // waiting for its permit is pending work.
  #schedule(): void {
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }

    const first = this.#queue.first
    if (first === undefined) {
      return
    }

    const delay = clampDelay(
      this.#origin + first.cycle * this.#limitRefreshPeriod - this.#clock.now(),
      `rate limiter "${this.#name}"`,
    )
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      this.#wake()
    }, delay)
  }

  // Starts every waiting call whose period has come, in the order they reserved.
  #wake(): void {
    const now = this.#clock.now()
    this.#refresh(now)
    const cycle = Math.floor((now - this.#origin) / this.#limitRefreshPeriod)

    let call = this.#queue.first
    while (call !== undefined && call.cycle <= cycle) {
      this.#leave(call)
      this.#admit(call, now)
      call = this.#queue.first
    }

    this.#schedule()
  }

  // Runs a call that waited for its permit, which it already holds, in its caller's context: it starts from a timer or
  // another call's continuation.
  #admit<T, I>(call: WaitingCall<T, I>, now: number): void {
    const restore = call.ctx.restore
    if (restore === undefined) {
      this.#start(call, now)
    } else {
      restoreWaitingCall(call.ctx, restore, () => this.#start(call, now), call.reject)
    }
  }

  #start<T, I>(call: WaitingCall<T, I>, now: number): void {
    if (this.#emitter.has('permitted')) {
      this.#emitter.emit('permitted', { name: this.#name, waited: now - call.since })
    }

    // Both handlers settle the caller's promise themselves and never throw.
    void call.inner(call.ctx, call.input).then(call.resolve, call.reject)
  }
}

disposable(RateLimiter)

/**
 * Creates a {@link RateLimiter}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function rateLimiter(options: RateLimiterOptions): RateLimiter {
  return new RateLimiter(options)
}
