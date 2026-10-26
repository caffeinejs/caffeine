import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { abortReason } from '../abort.js'
import { settled } from '../compose.js'
import { Emitter } from '../emitter.js'
import { ErrCallRefused, ErrInvalidOption, restoreStacks, suppressStacks } from '../errors.js'
import type { ExecutionContext, Next, StrategyObject } from '../strategy.js'
import { clampDelay, clock, type TimerHandle } from '../timers.js'
import { type Waiter, Waiters } from '../waiters.js'

/**
 * A rate limiter refused the call: no permit was left in this period, and the next one it could have had was further
 * away than it was allowed to wait. The operation did not run; `retryAfter` is how long until that permit.
 */
export class ErrRateLimitExceeded extends ErrCallRefused {
  // Built once rather than per refusal: refusals come in bulk once a quota is spent.
  static readonly #footer = errMessage('').reference('@caffeinejs/resilience', ErrRateLimitExceeded).build()

  /** The name of the rate limiter that refused the call. */
  readonly rateLimiter: string
  declare readonly retryAfter: Duration

  constructor(rateLimiter: string, limitForPeriod: number, limitRefreshPeriod: Duration, retryAfter: Duration) {
    super(
      `Cannot call "${rateLimiter}": rate limit of ${limitForPeriod} calls per ${formatDuration(limitRefreshPeriod)} reached${ErrRateLimitExceeded.#footer}`,
      'ERR_RATE_LIMIT_EXCEEDED',
      retryAfter,
    )
    this.name = 'ErrRateLimitExceeded'
    this.rateLimiter = rateLimiter
  }
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

interface WaitingCall<T> extends Waiter {
  readonly ctx: ExecutionContext
  readonly run: Next<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  readonly since: number
  // The period whose permit this call reserved.
  readonly cycle: number
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
export class RateLimiter implements StrategyObject {
  readonly #name: string
  readonly #limitForPeriod: number
  readonly #limitRefreshPeriod: Duration
  readonly #maxWaitMs: number
  readonly #captureStackTrace: boolean
  readonly #origin: number
  readonly #queue = new Waiters<WaitingCall<any>>()
  readonly #emitter = new Emitter<RateLimiterEvents>()
  #cycle = 0
  // Permits left in the current period; below zero, the permits of later periods that waiting calls reserved.
  #permits: number
  #rejected = 0
  #timer: TimerHandle | undefined

  constructor(options: RateLimiterOptions) {
    const name = (options as Partial<RateLimiterOptions> | undefined)?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new ErrInvalidOption(
        errMessage('Cannot create rate limiter: name must be a non-empty string')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    const invalid = (reason: string, ...solutions: string[]): ErrInvalidOption =>
      new ErrInvalidOption(
        errMessage(`Cannot create rate limiter "${name}": ${reason}`)
          .solutions(...solutions)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )

    const limitForPeriod = options.limitForPeriod
    if (!Number.isInteger(limitForPeriod) || limitForPeriod < 1) {
      throw invalid(
        `limitForPeriod must be an integer of at least 1, got ${String(limitForPeriod)}`,
        'Pass the calls the dependency allows per period, such as limitForPeriod: 100',
      )
    }

    const limitRefreshPeriod = options.limitRefreshPeriod
    if (typeof limitRefreshPeriod !== 'number' || !Number.isFinite(limitRefreshPeriod) || limitRefreshPeriod <= 0) {
      throw invalid(
        `limitRefreshPeriod must be a finite Duration greater than 0s, got ${formatDuration(limitRefreshPeriod)}`,
        'Pass the length of the quota period, such as limitRefreshPeriod: 1 * Second',
      )
    }

    const maxWaitDuration = options.maxWaitDuration ?? 0
    if (typeof maxWaitDuration !== 'number' || !Number.isFinite(maxWaitDuration) || maxWaitDuration < 0) {
      throw invalid(`maxWaitDuration must be a finite Duration of at least 0s, got ${formatDuration(maxWaitDuration)}`)
    }

    const captureStackTrace = options.captureStackTrace ?? false
    if (typeof captureStackTrace !== 'boolean') {
      throw invalid(`captureStackTrace must be a boolean, got ${typeof captureStackTrace}`)
    }

    this.#name = name
    this.#limitForPeriod = limitForPeriod
    this.#limitRefreshPeriod = limitRefreshPeriod
    this.#maxWaitMs = clampDelay(maxWaitDuration, `the wait of rate limiter "${name}"`)
    this.#captureStackTrace = captureStackTrace
    this.#origin = clock.now()
    this.#permits = limitForPeriod
  }

  get name(): string {
    return this.#name
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof RateLimiterEvents>(type: K, listener: (event: RateLimiterEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  metrics(): RateLimiterMetrics {
    this.#refresh(clock.now())
    return {
      availablePermissions: this.#permits > 0 ? this.#permits : 0,
      waitingCalls: this.#queue.size,
      rejectedCalls: this.#rejected,
    }
  }

  run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
    const now = clock.now()
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

      // `run` is public, so `next` may be one the chain never normalised. It is called inside this frame's own `try`:
      // a helper that called it would add a frame to every stack trace.
      try {
        return settled(next(ctx))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    // The permits of the coming periods go, in order, to the calls that reserved them; this call would get the next.
    const cycle = this.#cycle + Math.ceil((1 - this.#permits) / this.#limitForPeriod)
    const wait = this.#origin + cycle * this.#limitRefreshPeriod - now
    if (wait > this.#maxWaitMs) {
      this.#rejected++
      if (this.#emitter.has('rejected')) {
        this.#emitter.emit('rejected', { name: this.#name, retryAfter: wait })
      }
      // Built here, in the frame that refuses, so a captured stack starts at `run` and not in a helper. Returned, not
      // thrown: throwing costs more than the rest of the refusal together.
      return Promise.reject(
        this.#captureStackTrace
          ? new ErrRateLimitExceeded(this.#name, this.#limitForPeriod, this.#limitRefreshPeriod, wait)
          : stackless(this.#name, this.#limitForPeriod, this.#limitRefreshPeriod, wait),
      )
    }

    const signal = ctx.signal
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(abortReason(signal))
    }

    this.#permits--
    return new Promise<T>((resolve, reject) => {
      const call: WaitingCall<T> = {
        ctx,
        run: next,
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
            // The last call in line gives its permit back: nobody reserved after it. Any other spends it, because the
            // calls after it reserved by count, and handing it on would put two calls in a period with room for one.
            if (tail) {
              this.#permits++
            }
            if (head) {
              this.#schedule()
            }
            reject(abortReason(signal))
          }
        }
        signal.addEventListener('abort', call.onAbort, { once: true })
      }
    })
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
      clearTimeout(this.#timer)
      this.#timer = undefined
    }

    const first = this.#queue.first
    if (first === undefined) {
      return
    }

    const delay = clampDelay(
      this.#origin + first.cycle * this.#limitRefreshPeriod - clock.now(),
      `rate limiter "${this.#name}"`,
    )
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#wake()
    }, delay)
  }

  // Starts every waiting call whose period has come, in the order they reserved.
  #wake(): void {
    const now = clock.now()
    this.#refresh(now)
    const cycle = Math.floor((now - this.#origin) / this.#limitRefreshPeriod)

    let call = this.#queue.first
    while (call !== undefined && call.cycle <= cycle) {
      this.#queue.remove(call)
      if (call.onAbort !== undefined) {
        call.ctx.signal?.removeEventListener('abort', call.onAbort)
      }
      this.#admit(call, now)
      call = this.#queue.first
    }

    this.#schedule()
  }

  // Runs a call that waited for its permit, which it already holds. Guarded like the call in `run`, and called from
  // this frame: a helper would add a frame to every stack trace.
  #admit<T>(call: WaitingCall<T>, now: number): void {
    if (this.#emitter.has('permitted')) {
      this.#emitter.emit('permitted', { name: this.#name, waited: now - call.since })
    }

    let pending: Promise<T>
    try {
      pending = settled(call.run(call.ctx))
    } catch (error) {
      pending = Promise.reject(error)
    }

    // Both handlers settle the caller's promise themselves and never throw.
    void pending.then(call.resolve, call.reject)
  }
}

// A refusal without a stack trace.
function stackless(
  rateLimiter: string,
  limitForPeriod: number,
  limitRefreshPeriod: Duration,
  retryAfter: Duration,
): ErrRateLimitExceeded {
  const limit = suppressStacks()
  try {
    return new ErrRateLimitExceeded(rateLimiter, limitForPeriod, limitRefreshPeriod, retryAfter)
  } finally {
    restoreStacks(limit)
  }
}

/**
 * Creates a {@link RateLimiter}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function rateLimiter(options: RateLimiterOptions): RateLimiter {
  return new RateLimiter(options)
}
