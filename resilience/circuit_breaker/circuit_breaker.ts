import type { Backoff } from '../backoff.js'
import { settled } from '../compose.js'
import { Emitter } from '../emitter.js'
import { ErrCallNotPermitted, ErrInvalidOption, type NotPermittedState } from '../errors.js'
import type { ExecutionContext, Next, StrategyObject } from '../strategy.js'
import { clampDelay, clock, scheduleUnref, type TimerHandle } from '../timers.js'
import { CountWindow, type Window } from './_count_window.js'
import { TimeWindow } from './_time_window.js'

export type CircuitBreakerState = 'closed' | 'open' | 'half_open' | 'forced_open' | 'disabled' | 'metrics_only'

/** The last `size` calls, or the calls of the last `seconds` seconds. */
export type SlidingWindow = { type: 'count'; size: number } | { type: 'time'; seconds: number }

export interface CircuitBreakerOptions {
  /** Names the breaker in errors, events and metrics. */
  name: string
  /** Failure rate, in percent, at or above which the breaker opens. Defaults to 50. */
  failureRateThreshold?: number
  /** Rate of slow calls, in percent, at or above which the breaker opens. Defaults to 100. */
  slowCallRateThreshold?: number
  /** A call that takes longer than this is slow. Defaults to 60 000. */
  slowCallDurationThresholdMs?: number
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
   * to 60 000.
   */
  waitDurationInOpenStateMs?: number | Backoff
  /** Trial calls let through while half open; their outcome closes or re-opens the breaker. Defaults to 10. */
  permittedNumberOfCallsInHalfOpenState?: number
  /**
   * Longest time the breaker may stay half open before it re-opens, for trial calls that never settle. `0`, the
   * default, waits for them forever.
   */
  maxWaitDurationInHalfOpenStateMs?: number
  /**
   * Moves an open breaker to half open when the wait elapses, instead of on the first call after it. The move on
   * the next call happens either way.
   */
  automaticTransitionFromOpenToHalfOpen?: boolean
  /** Whether an error counts as a failure; `false` counts it as a success. Every error counts by default. */
  recordError?: (error: unknown) => boolean
  /**
   * Errors the breaker neither counts nor lets affect its state. Checked before `recordError`. A failure after
   * the caller's signal aborted is always ignored.
   */
  ignoreError?: (error: unknown) => boolean
  /** Whether a returned value counts as a failure, such as a response with status 503. */
  recordResult?: (result: unknown) => boolean
  /**
   * Whether a refused call's {@link ErrCallNotPermitted} captures a stack trace. Off by default: refusals come in
   * bulk exactly while a dependency is down, capturing a stack costs several times the rest of the refusal, and the
   * error's `breaker` and `state` already say why the call failed.
   */
  captureStackTrace?: boolean
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
  success: { readonly name: string; readonly durationMs: number; readonly slow: boolean }
  /** `error` when the operation threw, `result` when `recordResult` classified a value as a failure. */
  failure: {
    readonly name: string
    readonly durationMs: number
    readonly slow: boolean
    readonly error?: unknown
    readonly result?: unknown
  }
  ignored: {
    readonly name: string
    readonly durationMs: number
    readonly error: unknown
    readonly reason: 'ignored' | 'aborted'
  }
  notPermitted: { readonly name: string; readonly state: NotPermittedState }
  stateChange: { readonly name: string; readonly from: CircuitBreakerState; readonly to: CircuitBreakerState }
  reset: { readonly name: string }
  failureRateExceeded: { readonly name: string; readonly failureRate: number }
  slowCallRateExceeded: { readonly name: string; readonly slowCallRate: number }
}

const CLOSED = 0
const OPEN = 1
const HALF_OPEN = 2
const FORCED_OPEN = 3
const DISABLED = 4
const METRICS_ONLY = 5

const STATES: readonly CircuitBreakerState[] = [
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
  readonly retryAfterMs: number | undefined
}

const FORCED_OPEN_REFUSAL: Refusal = { state: 'forced_open', retryAfterMs: undefined }
const HALF_OPEN_REFUSAL: Refusal = { state: 'half_open', retryAfterMs: undefined }

const errorClass = Error as { stackTraceLimit?: number }

// A refusal without a stack trace. The limit is process-wide, so it is restored before anything else can throw.
function stacklessRefusal(
  breaker: string,
  state: NotPermittedState,
  retryAfterMs: number | undefined,
): ErrCallNotPermitted {
  const limit = errorClass.stackTraceLimit
  errorClass.stackTraceLimit = 0
  try {
    return new ErrCallNotPermitted(breaker, state, retryAfterMs)
  } finally {
    errorClass.stackTraceLimit = limit
  }
}

/**
 * Stops calling a dependency that keeps failing or slowing down, and lets a few trial calls through after a wait
 * to find out whether it recovered.
 *
 * One instance protects one dependency and is shared by every call to it: the state is what the calls taught it.
 * Refused calls reject with {@link ErrCallNotPermitted}.
 */
export class CircuitBreaker implements StrategyObject {
  readonly #name: string
  readonly #failureRateThreshold: number
  readonly #slowCallRateThreshold: number
  readonly #slowCallDurationThresholdMs: number
  readonly #minimumNumberOfCalls: number
  readonly #waitDurationInOpenState: number | Backoff
  readonly #permittedCalls: number
  readonly #maxWaitInHalfOpenMs: number
  readonly #automaticTransition: boolean
  readonly #recordError: ((error: unknown) => boolean) | undefined
  readonly #ignoreError: ((error: unknown) => boolean) | undefined
  readonly #recordResult: ((result: unknown) => boolean) | undefined
  readonly #captureStackTrace: boolean
  readonly #window: Window
  readonly #halfOpenWindow: CountWindow
  readonly #emitter = new Emitter<CircuitBreakerEvents>()

  #state = CLOSED
  // Bumped on every state entry. A call records its outcome only if the generation it started in is current.
  #generation = 0
  #openedAt = 0
  #openWaitMs = 0
  #openCount = 0
  #halfOpenEnteredAt = 0
  #permits = 0
  #timer: TimerHandle | undefined
  #notPermittedCalls = 0
  // In metrics_only, a rate event is published when the rate crosses its threshold, not on every call above it.
  #failureRateAbove = false
  #slowCallRateAbove = false

  constructor(options: CircuitBreakerOptions) {
    const name = (options as Partial<CircuitBreakerOptions> | undefined)?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new ErrInvalidOption('Cannot create circuit breaker: name must be a non-empty string')
    }

    const invalid = (reason: string): ErrInvalidOption =>
      new ErrInvalidOption(`Cannot create circuit breaker "${name}": ${reason}`)

    const percent = (key: string, value: number): number => {
      if (typeof value !== 'number' || !(value > 0 && value <= 100)) {
        throw invalid(`${key} must be greater than 0 and at most 100, got ${String(value)}`)
      }
      return value
    }

    const count = (key: string, value: number): number => {
      if (!Number.isInteger(value) || value < 1) {
        throw invalid(`${key} must be an integer of at least 1, got ${String(value)}`)
      }
      return value
    }

    const milliseconds = (key: string, value: number, min: 0 | 1): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
        throw invalid(`${key} must be a finite number of at least ${min}, got ${String(value)}`)
      }
      return value
    }

    const predicate = <F>(key: string, value: F | undefined): F | undefined => {
      if (value !== undefined && typeof value !== 'function') {
        throw invalid(`${key} must be a function, got ${typeof value}`)
      }
      return value
    }

    this.#name = name
    this.#failureRateThreshold = percent('failureRateThreshold', options.failureRateThreshold ?? 50)
    this.#slowCallRateThreshold = percent('slowCallRateThreshold', options.slowCallRateThreshold ?? 100)
    this.#slowCallDurationThresholdMs = milliseconds(
      'slowCallDurationThresholdMs',
      options.slowCallDurationThresholdMs ?? 60_000,
      1,
    )

    const window = options.slidingWindow ?? { type: 'count', size: 100 }
    let minimum = count('minimumNumberOfCalls', options.minimumNumberOfCalls ?? 100)
    if (window.type === 'count') {
      const size = count('slidingWindow.size', window.size)
      this.#window = new CountWindow(size)
      minimum = Math.min(minimum, size)
    } else if (window.type === 'time') {
      this.#window = new TimeWindow(count('slidingWindow.seconds', window.seconds))
    } else {
      throw invalid(`slidingWindow must be { type: 'count', size } or { type: 'time', seconds }`)
    }
    this.#minimumNumberOfCalls = minimum

    const wait = options.waitDurationInOpenStateMs ?? 60_000
    this.#waitDurationInOpenState =
      typeof wait === 'function' ? wait : milliseconds('waitDurationInOpenStateMs', wait, 0)
    this.#permittedCalls = count(
      'permittedNumberOfCallsInHalfOpenState',
      options.permittedNumberOfCallsInHalfOpenState ?? 10,
    )
    this.#halfOpenWindow = new CountWindow(this.#permittedCalls)
    this.#maxWaitInHalfOpenMs = milliseconds(
      'maxWaitDurationInHalfOpenStateMs',
      options.maxWaitDurationInHalfOpenStateMs ?? 0,
      0,
    )

    const automatic = options.automaticTransitionFromOpenToHalfOpen ?? false
    if (typeof automatic !== 'boolean') {
      throw invalid(`automaticTransitionFromOpenToHalfOpen must be a boolean, got ${typeof automatic}`)
    }
    this.#automaticTransition = automatic

    const captureStackTrace = options.captureStackTrace ?? false
    if (typeof captureStackTrace !== 'boolean') {
      throw invalid(`captureStackTrace must be a boolean, got ${typeof captureStackTrace}`)
    }
    this.#captureStackTrace = captureStackTrace

    this.#recordError = predicate('recordError', options.recordError)
    this.#ignoreError = predicate('ignoreError', options.ignoreError)
    this.#recordResult = predicate('recordResult', options.recordResult)
  }

  get name(): string {
    return this.#name
  }

  get state(): CircuitBreakerState {
    return STATES[this.#state]
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof CircuitBreakerEvents>(type: K, listener: (event: CircuitBreakerEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
    const state = this.#state
    if (state === DISABLED) {
      try {
        return settled(next(ctx))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    let generation: number
    if (state === CLOSED || state === METRICS_ONLY) {
      generation = this.#generation
    } else {
      const admitted = this.#admit()
      if (typeof admitted !== 'number') {
        this.#refused(admitted.state)
        // Built here, in the frame that refuses, so a captured stack starts at `run` and not in a helper. Returned,
        // not thrown: throwing costs more than the rest of the refusal together.
        return Promise.reject(
          this.#captureStackTrace
            ? new ErrCallNotPermitted(this.#name, admitted.state, admitted.retryAfterMs)
            : stacklessRefusal(this.#name, admitted.state, admitted.retryAfterMs),
        )
      }
      generation = admitted
    }

    const start = clock.now()
    // `run` is public, so `next` may be one the chain never normalised. It is called inside this frame's own `try`: a
    // helper that called it would add a frame to every stack trace.
    let pending: Promise<T>
    try {
      pending = settled(next(ctx))
    } catch (error) {
      pending = Promise.reject(error)
    }

    return pending.then(
      result => {
        this.#onResult(generation, start, result)
        return result
      },
      error => {
        this.#onError(generation, start, error, ctx)
        throw error
      },
    )
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
    this.#window.reset()
    this.#halfOpenWindow.reset()
    this.#openCount = 0
    this.#transitionTo(CLOSED)

    if (this.#emitter.has('reset')) {
      this.#emitter.emit('reset', { name: this.#name })
    }
  }

  metrics(): CircuitBreakerMetrics {
    const halfOpen = this.#state === HALF_OPEN
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

  // The generation the call runs in, or why it is refused. It only decides: `run` builds the error, so no frame of
  // this method is in a captured stack.
  #admit(): number | Refusal {
    switch (this.#state) {
      case CLOSED:
      case METRICS_ONLY:
      case DISABLED:
        return this.#generation
      case FORCED_OPEN:
        return FORCED_OPEN_REFUSAL
      case OPEN: {
        const remaining = this.#openedAt + this.#openWaitMs - clock.now()
        if (remaining > 0) {
          return { state: 'open', retryAfterMs: remaining }
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
    // Checked before the permits: when hung trial calls hold every permit, this is the only way out.
    if (this.#maxWaitInHalfOpenMs > 0 && clock.now() - this.#halfOpenEnteredAt >= this.#maxWaitInHalfOpenMs) {
      this.#transitionTo(OPEN)
      return { state: 'open', retryAfterMs: this.#openWaitMs }
    }

    if (this.#permits > 0) {
      this.#permits--
      return this.#generation
    }

    return HALF_OPEN_REFUSAL
  }

  #refused(state: NotPermittedState): void {
    this.#notPermittedCalls++
    if (this.#emitter.has('notPermitted')) {
      this.#emitter.emit('notPermitted', { name: this.#name, state })
    }
  }

  #onError(generation: number, start: number, error: unknown, ctx: ExecutionContext): void {
    const now = clock.now()
    const durationMs = now - start

    let reason: 'ignored' | 'aborted' | undefined
    let failed: boolean
    try {
      if (ctx.signal !== undefined && ctx.signal.aborted) {
        reason = 'aborted'
      } else if (this.#ignoreError !== undefined && this.#ignoreError(error)) {
        reason = 'ignored'
      }
      failed = reason === undefined && (this.#recordError === undefined || this.#recordError(error))
    } catch (predicateError) {
      this.#release(generation)
      throw predicateError
    }

    if (reason !== undefined) {
      if (this.#emitter.has('ignored')) {
        this.#emitter.emit('ignored', { name: this.#name, durationMs, error, reason })
      }
      this.#release(generation)
      return
    }

    const slow = durationMs > this.#slowCallDurationThresholdMs
    if (failed) {
      if (this.#emitter.has('failure')) {
        this.#emitter.emit('failure', { name: this.#name, durationMs, slow, error })
      }
    } else if (this.#emitter.has('success')) {
      this.#emitter.emit('success', { name: this.#name, durationMs, slow })
    }

    this.#record(generation, failed, slow, now)
  }

  #onResult(generation: number, start: number, result: unknown): void {
    const now = clock.now()
    const durationMs = now - start

    let failed: boolean
    try {
      failed = this.#recordResult !== undefined && this.#recordResult(result)
    } catch (predicateError) {
      this.#release(generation)
      throw predicateError
    }

    const slow = durationMs > this.#slowCallDurationThresholdMs
    if (failed) {
      if (this.#emitter.has('failure')) {
        this.#emitter.emit('failure', { name: this.#name, durationMs, slow, result })
      }
    } else if (this.#emitter.has('success')) {
      this.#emitter.emit('success', { name: this.#name, durationMs, slow })
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
        if (this.#window.total >= this.#minimumNumberOfCalls) {
          this.#publishCrossings()
        }
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
    const tripped = this.#tripped(this.#window)
    const failureAbove = tripped.failureRate !== undefined
    const slowAbove = tripped.slowCallRate !== undefined
    const crossed: Tripped = {
      failureRate: failureAbove && !this.#failureRateAbove ? tripped.failureRate : undefined,
      slowCallRate: slowAbove && !this.#slowCallRateAbove ? tripped.slowCallRate : undefined,
    }
    this.#failureRateAbove = failureAbove
    this.#slowCallRateAbove = slowAbove

    this.#emitRates(crossed)
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
  // again. `tripped` is set when a threshold opened the breaker.
  #transitionTo(target: number, tripped?: Tripped): void {
    // Computed first: a wait function that throws or returns a non-finite delay leaves the breaker as it was.
    const waitMs = target === OPEN ? this.#openWait() : 0
    const from = this.#state
    const now = clock.now()

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }

    this.#state = target
    this.#generation++

    switch (target) {
      case OPEN:
        this.#openedAt = now
        this.#openCount++
        this.#openWaitMs = waitMs
        if (this.#automaticTransition) {
          this.#scheduleHalfOpen(waitMs)
        }
        break
      case HALF_OPEN:
        this.#halfOpenEnteredAt = now
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
      this.#emitter.emit('stateChange', { name: this.#name, from: STATES[from], to: STATES[target] })
    }
  }

  #openWait(): number {
    const wait = this.#waitDurationInOpenState
    const ms = typeof wait === 'number' ? wait : wait(this.#openCount + 1)
    return clampDelay(ms, `the open state of circuit breaker "${this.#name}"`)
  }

  #scheduleHalfOpen(waitMs: number): void {
    const generation = this.#generation
    this.#timer = scheduleUnref(() => {
      this.#timer = undefined
      if (this.#state === OPEN && this.#generation === generation) {
        this.#transitionTo(HALF_OPEN)
      }
    }, waitMs)
  }
}

/**
 * Creates a {@link CircuitBreaker}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function circuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(options)
}
