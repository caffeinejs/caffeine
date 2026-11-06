import { type Duration, formatDuration, Minute, Second } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import type { Backoff } from '../backoff.js'
import { lift, mark } from '../compose.js'
import { disposable } from '../dispose.js'
import { Emitter } from '../emitter.js'
import { ErrCallRefused, type ErrorMatcher, refusal } from '../errors.js'
import { Options } from '../options.js'
import type { CallContext, Operation, Wrapper } from '../policy.js'
import { clampDelay, type Clock, scheduleUnref } from '../timers.js'
import { CountWindow, type Window } from './_count_window.js'
import { TimeWindow } from './_time_window.js'

/** The circuit breaker states in which a call can be refused. */
export type NotPermittedState = 'open' | 'forced_open' | 'half_open'

const refusals: Record<NotPermittedState, string> = {
  open: 'circuit breaker is open',
  forced_open: 'circuit breaker is forced open',
  half_open: 'circuit breaker is half open and every trial call is in use',
}

/**
 * A circuit breaker refused the call; the operation did not run.
 *
 * `retryAfter` is the time left before the breaker lets trial calls through again. It is set only when `state`
 * is `open`: a forced-open breaker stays open until someone resets it, and a half-open one frees a trial slot when
 * a trial call settles.
 */
export class ErrCallNotPermitted extends ErrCallRefused {
  /** The name of the circuit breaker that refused the call. */
  readonly breaker: string
  readonly state: NotPermittedState

  constructor(breaker: string, state: NotPermittedState, retryAfter: Duration | undefined) {
    super(notPermittedMessage(breaker, state), 'ERR_CALL_NOT_PERMITTED', retryAfter)
    this.name = 'ErrCallNotPermitted'
    this.breaker = breaker
    this.state = state
  }
}

// Built once rather than per refusal: refusals come in bulk while a dependency is down, and the footer is the same
// for every one of them.
const footer = errMessage('').reference('@caffeinejs/resilience', ErrCallNotPermitted).build()

function notPermittedMessage(breaker: string, state: NotPermittedState): string {
  return `Cannot call "${breaker}": ${refusals[state]}${footer}`
}

export type CircuitBreakerState = 'closed' | 'open' | 'half_open' | 'forced_open' | 'disabled' | 'metrics_only'

/** The last `size` calls, or the calls of the last `duration`, a whole number of seconds. */
export type SlidingWindow = { type: 'count'; size: number } | { type: 'time'; duration: Duration }

export interface CircuitBreakerOptions {
  /** Names the breaker in errors, events and metrics. */
  name: string
  /** Failure rate, in percent, at or above which the breaker opens. Defaults to 50. */
  failureRateThreshold?: number
  /** Rate of slow calls, in percent, at or above which the breaker opens. Defaults to 100. */
  slowCallRateThreshold?: number
  /** A call that takes longer than this is slow. Defaults to one minute. */
  slowCallDurationThreshold?: Duration
  /** Defaults to the last 100 calls. */
  slidingWindow?: SlidingWindow
  /**
   * Calls the window must hold before a rate is computed; below it the breaker cannot open. Defaults to 100, and
   * never exceeds the size of a count window.
   */
  minimumNumberOfCalls?: number
  /**
   * How long the breaker stays open before it lets trial calls through. A function receives how many times in a
   * row the breaker has opened, starting at 1, so an `exponential()` backoff lengthens repeated waits. Defaults
   * to one minute.
   *
   * A function that returns anything but a finite number fails whatever opens the breaker with
   * {@link ErrInvalidOption}: the wrapped call that tripped it rejects, and `acquire()`, a permit's `onResult()` or
   * `onError()`, and `transitionToOpen()` throw.
   */
  waitDurationInOpenState?: Duration | Backoff
  /** Trial calls let through while half open; their outcome closes or re-opens the breaker. Defaults to 10. */
  permittedNumberOfCallsInHalfOpenState?: number
  /**
   * Longest time trial calls may hold every trial slot. Once all slots are taken and the last trial admitted has
   * run this long, the next call re-opens the breaker. Time spent half open with a free slot does not count. `0`,
   * the default, waits for the trial calls forever.
   */
  maxWaitDurationInHalfOpenState?: Duration
  /**
   * Moves an open breaker to half open when the wait elapses, instead of on the first call after it. The move on
   * the next call happens either way.
   */
  automaticTransitionFromOpenToHalfOpen?: boolean
  /**
   * Which errors count as failures: a predicate, or error classes whose instances do. Any other error counts as a
   * success. Every error counts by default.
   */
  recordError?: ErrorMatcher
  /**
   * Errors the breaker neither counts nor lets affect its state: a predicate, or error classes. Checked before
   * `recordError`. A failure after the caller's signal aborted is always ignored, and so are a refusal
   * ({@link ErrCallRefused}) from a policy inside the breaker, such as a spent rate limit or a full bulkhead, and a
   * client error (`CallContext.isClientError`).
   */
  ignoreError?: ErrorMatcher
  /** Whether a returned value counts as a failure, such as a response with status 503. */
  recordResult?: (result: unknown) => boolean
  /**
   * Whether a refused call's {@link ErrCallNotPermitted} captures a stack trace. Off by default: refusals come in
   * bulk exactly while a dependency is down, capturing a stack costs several times the rest of the refusal, and the
   * error's `breaker` and `state` already say why the call failed.
   */
  captureStackTrace?: boolean
  /** Where the breaker reads the time and sets its timer. Defaults to the runtime's. */
  clock?: Clock
}

/** Rates are in percent, and `undefined` while the window holds fewer calls than the minimum. */
export interface CircuitBreakerMetrics {
  readonly failureRate: number | undefined
  readonly slowCallRate: number | undefined
  readonly bufferedCalls: number
  readonly failedCalls: number
  readonly successfulCalls: number
  readonly slowCalls: number
  readonly slowFailedCalls: number
  readonly slowSuccessfulCalls: number
  /** Every call refused since the breaker was created; `reset()` leaves it alone. */
  readonly notPermittedCalls: number
}

export interface CircuitBreakerEvents {
  success: { readonly name: string; readonly duration: Duration; readonly slow: boolean }
  /** `error` when the operation threw, `result` when `recordResult` classified a value as a failure. */
  failure: {
    readonly name: string
    readonly duration: Duration
    readonly slow: boolean
    readonly error?: unknown
    readonly result?: unknown
  }
  ignored: {
    readonly name: string
    readonly duration: Duration
    readonly error: unknown
    /** `refused` when a policy inside the breaker refused the call. */
    readonly reason: 'ignored' | 'aborted' | 'refused'
  }
  notPermitted: { readonly name: string; readonly state: NotPermittedState }
  stateChange: { readonly name: string; readonly from: CircuitBreakerState; readonly to: CircuitBreakerState }
  reset: { readonly name: string }
  failureRateExceeded: { readonly name: string; readonly failureRate: number }
  slowCallRateExceeded: { readonly name: string; readonly slowCallRate: number }
}

/**
 * A call {@link CircuitBreaker.acquire} let through. Settle it once, when the work ends; a second settlement does
 * nothing. The call's duration runs from `acquire()`. A predicate that throws throws from the method that ran it,
 * and the call is not recorded.
 */
export interface CircuitBreakerPermit {
  /** The work succeeded. */
  onSuccess(): void
  /**
   * The work returned `result`, which counts as a failure when `recordResult` says so.
   *
   * @throws {@link ErrInvalidOption} when the failure opens the breaker and `waitDurationInOpenState` returns no
   * finite number.
   */
  onResult(result: unknown): void
  /**
   * The work failed with `error`, which `ignoreError` and `recordError` classify as they do a wrapped call's.
   *
   * @throws {@link ErrInvalidOption} when the failure opens the breaker and `waitDurationInOpenState` returns no
   * finite number.
   */
  onError(error: unknown): void
  /** The work was abandoned, such as when its caller left: nothing is recorded, and a trial slot is given back. */
  release(): void
}

const CLOSED = 0
const OPEN = 1
const HALF_OPEN = 2
const FORCED_OPEN = 3
const DISABLED = 4
const METRICS_ONLY = 5

// Indexed by the numeric states above; the OpenTelemetry binding reports one series per entry.
export const CIRCUIT_BREAKER_STATES: readonly CircuitBreakerState[] = [
  'closed',
  'open',
  'half_open',
  'forced_open',
  'disabled',
  'metrics_only',
]

// The rates that opened the breaker, computed before the transition so its events describe the deciding window.
interface Tripped {
  readonly failureRate: number | undefined
  readonly slowCallRate: number | undefined
}

// Why a call was refused. Only an open breaker tells the caller how long to wait.
interface Refusal {
  readonly state: NotPermittedState
  readonly retryAfter: Duration | undefined
}

const FORCED_OPEN_REFUSAL: Refusal = { state: 'forced_open', retryAfter: undefined }
const HALF_OPEN_REFUSAL: Refusal = { state: 'half_open', retryAfter: undefined }

/**
 * Stops calling a dependency that keeps failing or slowing down, and lets a few trial calls through after a wait
 * to find out whether it recovered.
 *
 * One instance protects one dependency and is shared by every call to it: the state is what the calls taught it.
 * Refused calls reject with {@link ErrCallNotPermitted}.
 */
export class CircuitBreaker implements Wrapper {
  declare [Symbol.dispose]: () => void
  readonly #name: string
  readonly #failureRateThreshold: number
  readonly #slowCallRateThreshold: number
  readonly #slowCallDurationThresholdMs: number
  readonly #minimumNumberOfCalls: number
  readonly #waitDurationInOpenState: Duration | Backoff
  readonly #permittedCalls: number
  readonly #maxWaitInHalfOpenMs: number
  readonly #automaticTransition: boolean
  readonly #recordError: ((error: unknown) => boolean) | undefined
  readonly #ignoreError: ((error: unknown) => boolean) | undefined
  readonly #recordResult: ((result: unknown) => boolean) | undefined
  readonly #captureStackTrace: boolean
  readonly #clock: Clock
  readonly #window: Window
  readonly #halfOpenWindow: CountWindow
  readonly #emitter = new Emitter<CircuitBreakerEvents>()

  #state = CLOSED
  // Bumped on every state entry. A call records its outcome only if the generation it started in is current.
  #generation = 0
  #openedAt = 0
  #openWaitMs = 0
  #openCount = 0
  #lastTrialAt = 0
  #permits = 0
  #timer: unknown
  #notPermittedCalls = 0
  // In metrics_only, a rate event is published when the rate crosses its threshold, not on every call above it.
  #failureRateAbove = false
  #slowCallRateAbove = false
  #disposed = false

  constructor(options: CircuitBreakerOptions) {
    const o = new Options('circuit breaker', options)

    // A length the runtime cannot allocate is an option out of range, not a crash inside a typed array.
    const allocate = <W>(key: string, create: () => W): W => {
      try {
        return create()
      } catch (error) {
        if (error instanceof RangeError) {
          throw o.invalid(`${key} is too large to allocate`)
        }
        throw error
      }
    }

    this.#name = o.name
    this.#failureRateThreshold = o.percent('failureRateThreshold', options.failureRateThreshold ?? 50)
    this.#slowCallRateThreshold = o.percent('slowCallRateThreshold', options.slowCallRateThreshold ?? 100)
    this.#slowCallDurationThresholdMs = o.duration(
      'slowCallDurationThreshold',
      options.slowCallDurationThreshold ?? 1 * Minute,
      1,
    )

    const window = options.slidingWindow ?? { type: 'count', size: 100 }
    let minimum = o.integer('minimumNumberOfCalls', options.minimumNumberOfCalls ?? 100, 1)
    if (window.type === 'count') {
      const size = o.integer('slidingWindow.size', window.size, 1)
      this.#window = allocate('slidingWindow.size', () => new CountWindow(size))
      minimum = Math.min(minimum, size)
    } else if (window.type === 'time') {
      // One bucket per second.
      const seconds = window.duration / Second
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw o.invalid(
          `slidingWindow.duration must be a whole number of seconds and at least 1s, got ${formatDuration(window.duration)}`,
        )
      }
      this.#window = allocate('slidingWindow.duration', () => new TimeWindow(seconds))
    } else {
      throw o.invalid(`slidingWindow must be { type: 'count', size } or { type: 'time', duration }`)
    }
    this.#minimumNumberOfCalls = minimum

    const wait = options.waitDurationInOpenState ?? 1 * Minute
    this.#waitDurationInOpenState = typeof wait === 'function' ? wait : o.duration('waitDurationInOpenState', wait, 0)
    this.#permittedCalls = o.integer(
      'permittedNumberOfCallsInHalfOpenState',
      options.permittedNumberOfCallsInHalfOpenState ?? 10,
      1,
    )
    this.#halfOpenWindow = allocate(
      'permittedNumberOfCallsInHalfOpenState',
      () => new CountWindow(this.#permittedCalls),
    )
    this.#maxWaitInHalfOpenMs = o.duration(
      'maxWaitDurationInHalfOpenState',
      options.maxWaitDurationInHalfOpenState ?? 0,
      0,
    )
    this.#automaticTransition = o.boolean(
      'automaticTransitionFromOpenToHalfOpen',
      options.automaticTransitionFromOpenToHalfOpen,
      false,
    )
    this.#captureStackTrace = o.boolean('captureStackTrace', options.captureStackTrace, false)
    this.#recordError = o.matcher('recordError', options.recordError)
    this.#ignoreError = o.matcher('ignoreError', options.ignoreError)
    this.#recordResult = o.function('recordResult', options.recordResult)
    this.#clock = o.clock(options.clock)
  }

  get name(): string {
    return this.#name
  }

  get state(): CircuitBreakerState {
    return CIRCUIT_BREAKER_STATES[this.#state]
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof CircuitBreakerEvents>(type: K, listener: (event: CircuitBreakerEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  wrap<T, I = void>(op: Operation<T, I>): Operation<T, I> {
    const inner = lift(op)
    return mark((ctx, input) => {
      const state = this.#state
      if (state === DISABLED) {
        return inner(ctx, input)
      }

      let generation: number
      if (state === CLOSED || state === METRICS_ONLY) {
        generation = this.#generation
      } else {
        let admitted: number | Refusal
        try {
          admitted = this.#admit()
        } catch (error) {
          // Re-opening asks the wait function for a delay, and that function may throw. It rejects, like a refusal.
          return Promise.reject(error)
        }
        if (typeof admitted !== 'number') {
          this.#refused(admitted.state)
          // Returned, not thrown: throwing costs more than the rest of the refusal together.
          return Promise.reject(this.#notPermitted(admitted))
        }
        generation = admitted
      }

      const start = this.#clock.now()
      return inner(ctx, input).then(
        result => {
          this.#onResult(generation, start, result, true)
          return result
        },
        error => {
          this.#onError(generation, start, error, ctx)
          throw error
        },
      )
    })
  }

  // The refusal, with a stack trace only when asked for one.
  #notPermitted({ state, retryAfter }: Refusal): ErrCallNotPermitted {
    if (this.#captureStackTrace) {
      return new ErrCallNotPermitted(this.#name, state, retryAfter)
    }
    return refusal(ErrCallNotPermitted, notPermittedMessage(this.#name, state), {
      code: 'ERR_CALL_NOT_PERMITTED',
      name: 'ErrCallNotPermitted',
      retryAfter,
      breaker: this.#name,
      state,
    })
  }

  /** Refuses every call until {@link CircuitBreaker.reset}. */
  forceOpen(): void {
    if (this.#state !== FORCED_OPEN) {
      this.#transitionTo(FORCED_OPEN)
    }
  }

  /** Lets every call through and records nothing until {@link CircuitBreaker.reset}. */
  disable(): void {
    if (this.#state !== DISABLED) {
      this.#transitionTo(DISABLED)
    }
  }

  /** Records calls and emits events, but never opens, until {@link CircuitBreaker.reset}. */
  metricsOnly(): void {
    if (this.#state !== METRICS_ONLY) {
      this.#transitionTo(METRICS_ONLY)
    }
  }

  /**
   * Closes the breaker and forgets what it recorded. Calls in flight when it resets are not recorded when they
   * settle.
   */
  reset(): void {
    this.#transitionTo(CLOSED)

    if (this.#emitter.has('reset')) {
      this.#emitter.emit('reset', { name: this.#name })
    }
  }

  /**
   * Opens the breaker, as a reached threshold does: it refuses calls until the wait passes, then lets trial calls
   * through. `for` sets that wait instead of `waitDurationInOpenState`. Calls in flight are not recorded when they
   * settle.
   *
   * @throws {@link ErrInvalidOption} when `for` is not a finite Duration of at least 0s, or, without `for`, when
   * `waitDurationInOpenState` returns no finite number.
   */
  transitionToOpen(options?: { readonly for?: Duration }): void {
    const wait = options?.for
    if (wait === undefined) {
      this.#transitionTo(OPEN)
      return
    }

    const o = new Options('circuit breaker', { name: this.#name }, 'open')
    this.#transitionTo(
      OPEN,
      undefined,
      clampDelay(o.duration('for', wait, 0), `the open state of circuit breaker "${this.#name}"`),
    )
  }

  /** Lets trial calls through now, without waiting for the open state to end. Calls in flight are not recorded. */
  transitionToHalfOpen(): void {
    this.#transitionTo(HALF_OPEN)
  }

  /**
   * Closes the breaker and forgets what it recorded, as {@link CircuitBreaker.reset} does without its `reset` event.
   * Calls in flight are not recorded.
   */
  transitionToClosed(): void {
    this.#transitionTo(CLOSED)
  }

  /**
   * Lets one call through, or refuses it, for work that is not one operation, such as a body streamed after the
   * response started: the caller settles the permit when the work ends. A refusal is returned, not thrown, and
   * counted as a wrapped call's is.
   *
   * @throws {@link ErrInvalidOption} when a half-open breaker whose trial calls outstayed
   * `maxWaitDurationInHalfOpenState` re-opens, and `waitDurationInOpenState` returns no finite number.
   */
  acquire(): CircuitBreakerPermit | ErrCallNotPermitted {
    const admitted = this.#admit()
    if (typeof admitted !== 'number') {
      this.#refused(admitted.state)
      return this.#notPermitted(admitted)
    }

    const start = this.#clock.now()
    // A disabled breaker records nothing, as it does for a wrapped call.
    let settled = this.#state === DISABLED
    return {
      onSuccess: () => {
        if (!settled) {
          settled = true
          this.#onResult(admitted, start, undefined, false)
        }
      },
      onResult: result => {
        if (!settled) {
          settled = true
          this.#onResult(admitted, start, result, true)
        }
      },
      onError: error => {
        if (!settled) {
          settled = true
          this.#onError(admitted, start, error, undefined)
        }
      },
      release: () => {
        if (!settled) {
          settled = true
          this.#release(admitted)
        }
      },
    }
  }

  /**
   * Cancels the timer that moves an open breaker to half open, and sets none from then on, so no timer outlives a
   * shutdown. The breaker keeps working: an open one moves to half open on the first call after its wait. The
   * `[Symbol.dispose]` alias does the same.
   */
  dispose(): void {
    this.#disposed = true
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  metrics(): CircuitBreakerMetrics {
    const state = this.#state
    // Only a window that still records ages; an open breaker keeps showing the window that opened it.
    if ((state === CLOSED || state === METRICS_ONLY) && this.#window instanceof TimeWindow) {
      this.#window.advance(this.#clock.now())
    }

    const halfOpen = state === HALF_OPEN
    const window = halfOpen ? this.#halfOpenWindow : this.#window
    const minimum = halfOpen ? this.#permittedCalls : this.#minimumNumberOfCalls
    const { total, failed, slow, slowFailed } = window
    const measured = total > 0 && total >= minimum

    return {
      failureRate: measured ? (failed / total) * 100 : undefined,
      slowCallRate: measured ? (slow / total) * 100 : undefined,
      bufferedCalls: total,
      failedCalls: failed,
      successfulCalls: total - failed,
      slowCalls: slow,
      slowFailedCalls: slowFailed,
      slowSuccessfulCalls: slow - slowFailed,
      notPermittedCalls: this.#notPermittedCalls,
    }
  }

  // The generation the call runs in, or why it is refused. It only decides: the caller builds the error.
  #admit(): number | Refusal {
    switch (this.#state) {
      case CLOSED:
      case METRICS_ONLY:
      case DISABLED:
        return this.#generation
      case FORCED_OPEN:
        return FORCED_OPEN_REFUSAL
      case OPEN: {
        const remaining = this.#openedAt + this.#openWaitMs - this.#clock.now()
        if (remaining > 0) {
          return { state: 'open', retryAfter: remaining }
        }

        this.#transitionTo(HALF_OPEN)
        // A stateChange listener may have moved the breaker again; decide from where it is now.
        return this.#admit()
      }
      default:
        return this.#admitTrial()
    }
  }

  #admitTrial(): number | Refusal {
    if (this.#permits > 0) {
      this.#permits--
      if (this.#maxWaitInHalfOpenMs > 0) {
        this.#lastTrialAt = this.#clock.now()
      }
      return this.#generation
    }

    // Every trial slot is taken, and each unsettled trial was admitted at or before the last one. Once the last has
    // run for the maximum wait, all of them have: they hung, and this is the only way out. Time spent half open with
    // a free slot says nothing about the dependency and is not counted.
    if (this.#maxWaitInHalfOpenMs > 0 && this.#clock.now() - this.#lastTrialAt >= this.#maxWaitInHalfOpenMs) {
      this.#transitionTo(OPEN)
      // A stateChange listener may have moved the breaker again; decide from where it is now.
      return this.#admit()
    }

    return HALF_OPEN_REFUSAL
  }

  #refused(state: NotPermittedState): void {
    this.#notPermittedCalls++
    if (this.#emitter.has('notPermitted')) {
      this.#emitter.emit('notPermitted', { name: this.#name, state })
    }
  }

  // `ctx` is the wrapped call's; a permit's work has none.
  #onError(generation: number, start: number, error: unknown, ctx: CallContext | undefined): void {
    const now = this.#clock.now()
    const duration = now - start

    let reason: 'ignored' | 'aborted' | 'refused' | undefined
    let failed: boolean
    try {
      if (ctx !== undefined && ctx.signal !== undefined && ctx.signal.aborted) {
        reason = 'aborted'
      } else if (error instanceof ErrCallRefused) {
        // This process turned the call away; the dependency never saw it.
        reason = 'refused'
      } else if (
        (ctx !== undefined && ctx.isClientError !== undefined && ctx.isClientError(error)) ||
        (this.#ignoreError !== undefined && this.#ignoreError(error))
      ) {
        reason = 'ignored'
      }
      failed = reason === undefined && (this.#recordError === undefined || this.#recordError(error))
    } catch (predicateError) {
      this.#release(generation)
      throw predicateError
    }

    if (reason !== undefined) {
      if (this.#emitter.has('ignored')) {
        this.#emitter.emit('ignored', { name: this.#name, duration, error, reason })
      }
      this.#release(generation)
      return
    }

    const slow = duration > this.#slowCallDurationThresholdMs
    if (failed) {
      if (this.#emitter.has('failure')) {
        this.#emitter.emit('failure', { name: this.#name, duration, slow, error })
      }
    } else if (this.#emitter.has('success')) {
      this.#emitter.emit('success', { name: this.#name, duration, slow })
    }

    this.#record(generation, failed, slow, now)
  }

  // `classify` is false for a success reported without a result, which `recordResult` has nothing to judge.
  #onResult(generation: number, start: number, result: unknown, classify: boolean): void {
    const now = this.#clock.now()
    const duration = now - start

    let failed = false
    if (classify && this.#recordResult !== undefined) {
      try {
        failed = this.#recordResult(result)
      } catch (predicateError) {
        this.#release(generation)
        throw predicateError
      }
    }

    const slow = duration > this.#slowCallDurationThresholdMs
    if (failed) {
      if (this.#emitter.has('failure')) {
        this.#emitter.emit('failure', { name: this.#name, duration, slow, result })
      }
    } else if (this.#emitter.has('success')) {
      this.#emitter.emit('success', { name: this.#name, duration, slow })
    }

    this.#record(generation, failed, slow, now)
  }

  // Gives back the trial slot of a half-open call whose outcome is not recorded.
  #release(generation: number): void {
    if (generation === this.#generation && this.#state === HALF_OPEN) {
      this.#permits++
    }
  }

  #record(generation: number, failed: boolean, slow: boolean, now: number): void {
    // A call that started before the last state change: its outcome belongs to a state that no longer exists.
    if (generation !== this.#generation) {
      return
    }

    switch (this.#state) {
      case CLOSED: {
        this.#window.record(failed, slow, now)
        if (this.#window.total >= this.#minimumNumberOfCalls && this.#exceeded(this.#window)) {
          this.#transitionTo(OPEN, this.#tripped(this.#window))
        }
        return
      }
      case METRICS_ONLY:
        this.#window.record(failed, slow, now)
        this.#publishCrossings()
        return
      case HALF_OPEN:
        this.#halfOpenWindow.record(failed, slow)
        if (this.#halfOpenWindow.total >= this.#permittedCalls) {
          const opens = this.#exceeded(this.#halfOpenWindow)
          this.#transitionTo(opens ? OPEN : CLOSED, opens ? this.#tripped(this.#halfOpenWindow) : undefined)
        }
        return
    }
  }

  // Whether a threshold is reached, compared without division. Runs on every recorded call, so it only compares.
  #exceeded(window: Window): boolean {
    const { total, failed, slow } = window
    return failed * 100 >= this.#failureRateThreshold * total || slow * 100 >= this.#slowCallRateThreshold * total
  }

  // The rates behind a threshold that was reached; only computed when the breaker is about to open.
  #tripped(window: Window): Tripped {
    const { total, failed, slow } = window
    return {
      failureRate: failed * 100 >= this.#failureRateThreshold * total ? (failed / total) * 100 : undefined,
      slowCallRate: slow * 100 >= this.#slowCallRateThreshold * total ? (slow / total) * 100 : undefined,
    }
  }

  #publishCrossings(): void {
    const { total, failed, slow } = this.#window
    // Under the minimum there is no rate, so a rate that was above is no longer: its next crossing is a new one.
    const measured = total >= this.#minimumNumberOfCalls
    const failureAbove = measured && failed * 100 >= this.#failureRateThreshold * total
    const slowAbove = measured && slow * 100 >= this.#slowCallRateThreshold * total
    const failureCrossed = failureAbove && !this.#failureRateAbove
    const slowCrossed = slowAbove && !this.#slowCallRateAbove
    this.#failureRateAbove = failureAbove
    this.#slowCallRateAbove = slowAbove

    if (failureCrossed && this.#emitter.has('failureRateExceeded')) {
      this.#emitter.emit('failureRateExceeded', { name: this.#name, failureRate: (failed / total) * 100 })
    }
    if (slowCrossed && this.#emitter.has('slowCallRateExceeded')) {
      this.#emitter.emit('slowCallRateExceeded', { name: this.#name, slowCallRate: (slow / total) * 100 })
    }
  }

  #emitRates(rates: Tripped): void {
    if (rates.failureRate !== undefined && this.#emitter.has('failureRateExceeded')) {
      this.#emitter.emit('failureRateExceeded', { name: this.#name, failureRate: rates.failureRate })
    }
    if (rates.slowCallRate !== undefined && this.#emitter.has('slowCallRateExceeded')) {
      this.#emitter.emit('slowCallRateExceeded', { name: this.#name, slowCallRate: rates.slowCallRate })
    }
  }

  // Every field is updated before any event is emitted, so a listener sees a consistent breaker and may move it
  // again. `tripped` is set when a threshold opened the breaker; `wait` replaces the configured open wait.
  #transitionTo(target: number, tripped?: Tripped, wait?: number): void {
    // Computed first: a wait function that throws or returns a non-finite delay leaves the breaker as it was.
    const waitMs = target === OPEN ? (wait ?? this.#openWait()) : 0
    const from = this.#state
    const now = this.#clock.now()

    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }

    this.#state = target
    this.#generation++

    switch (target) {
      case OPEN:
        this.#openedAt = now
        this.#openCount++
        this.#openWaitMs = waitMs
        if (this.#automaticTransition && !this.#disposed) {
          this.#scheduleHalfOpen(waitMs)
        }
        break
      case HALF_OPEN:
        this.#permits = this.#permittedCalls
        this.#halfOpenWindow.reset()
        break
      case CLOSED:
        this.#window.reset()
        this.#openCount = 0
        this.#failureRateAbove = false
        this.#slowCallRateAbove = false
        break
    }

    if (tripped !== undefined && target === OPEN) {
      this.#emitRates(tripped)
    }

    if (from !== target && this.#emitter.has('stateChange')) {
      this.#emitter.emit('stateChange', {
        name: this.#name,
        from: CIRCUIT_BREAKER_STATES[from],
        to: CIRCUIT_BREAKER_STATES[target],
      })
    }
  }

  #openWait(): number {
    const wait = this.#waitDurationInOpenState
    const ms = typeof wait === 'number' ? wait : wait(this.#openCount + 1)
    return clampDelay(ms, `the open state of circuit breaker "${this.#name}"`)
  }

  #scheduleHalfOpen(waitMs: number): void {
    const generation = this.#generation
    this.#timer = scheduleUnref(
      this.#clock,
      () => {
        this.#timer = undefined
        if (this.#state === OPEN && this.#generation === generation) {
          this.#transitionTo(HALF_OPEN)
        }
      },
      waitMs,
    )
  }
}

disposable(CircuitBreaker)

/**
 * Creates a {@link CircuitBreaker}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function circuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(options)
}
