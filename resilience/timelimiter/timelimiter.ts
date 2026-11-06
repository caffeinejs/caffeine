import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { lift, mark } from '../compose.js'
import { detached, Emitter } from '../emitter.js'
import { ErrResilience } from '../errors.js'
import { Options } from '../options.js'
import type { Operation, Wrapper } from '../policy.js'
import { clampDelay, type Clock } from '../timers.js'

/**
 * The rest of the chain ran past the time limit. The operation was told through its signal, which aborted with
 * this error as its reason; whether it stopped is up to the operation.
 */
export class ErrTimeLimitExceeded extends ErrResilience {
  /** The name of the time limiter whose limit was exceeded. */
  readonly timeLimiter: string
  readonly timeoutDuration: Duration

  constructor(timeLimiter: string, timeoutDuration: Duration) {
    super(
      errMessage(`Cannot complete "${timeLimiter}": time limit of ${formatDuration(timeoutDuration)} exceeded`)
        .reference('@caffeinejs/resilience', ErrTimeLimitExceeded)
        .build(),
      'ERR_TIME_LIMIT_EXCEEDED',
    )
    this.name = 'ErrTimeLimitExceeded'
    this.timeLimiter = timeLimiter
    this.timeoutDuration = timeoutDuration
  }
}

export interface TimeLimiterOptions {
  /** Names the time limiter in errors, events and metrics. */
  name: string
  /** How long the rest of the chain may run. Required. */
  timeoutDuration: Duration
  /**
   * Releases a value that arrives after the call ended, by the time limit or by the caller, such as a response whose
   * body nobody will read: `discard: response => response.body?.cancel()`. Without it, the late value is dropped as
   * it is. A throw or a rejection from it resurfaces as uncaught, as a listener's does.
   */
  discard?: (value: unknown) => unknown
  /** Where the time limiter reads the time and sets its timer. Defaults to the runtime's. */
  clock?: Clock
}

/** Lifetime counts, one per call, by how it ended. A call the caller aborted is in none of them. */
export interface TimeLimiterMetrics {
  readonly successfulCalls: number
  readonly failedCalls: number
  readonly timedOutCalls: number
}

export interface TimeLimiterEvents {
  success: { readonly name: string; readonly duration: Duration }
  failure: { readonly name: string; readonly duration: Duration; readonly error: unknown }
  timeout: { readonly name: string; readonly timeoutDuration: Duration }
}

/**
 * Bounds how long the rest of the chain may run.
 *
 * The rest of the chain gets a signal of its own, which aborts with an {@link ErrTimeLimitExceeded} when the limit
 * passes, and with the caller's reason when the caller's signal aborts. Either way the call rejects at once, even if
 * the operation ignores its signal and never settles. The signal stays linked to the caller's after the call settles,
 * so a body the operation streams still learns that the caller left. An outcome that arrives after the call settled
 * is dropped, a value through `discard` when one is given.
 *
 * Its place in the chain decides what it bounds: inside a retry, each attempt; outside it, every attempt and every
 * wait between them.
 */
export class TimeLimiter implements Wrapper {
  readonly #name: string
  readonly #timeoutDuration: Duration
  readonly #timeoutMs: number
  readonly #discard: ((value: unknown) => unknown) | undefined
  readonly #clock: Clock
  readonly #emitter = new Emitter<TimeLimiterEvents>()
  #successful = 0
  #failed = 0
  #timedOut = 0

  constructor(options: TimeLimiterOptions) {
    const o = new Options('time limiter', options)
    this.#name = o.name
    this.#timeoutDuration = o.positiveDuration(
      'timeoutDuration',
      options.timeoutDuration,
      'Pass the longest the call may take, such as timeoutDuration: 2 * Second',
    )
    this.#timeoutMs = clampDelay(this.#timeoutDuration, `time limiter "${o.name}"`)
    this.#discard = o.function('discard', options.discard)
    this.#clock = o.clock(options.clock)
  }

  get name(): string {
    return this.#name
  }

  get timeoutDuration(): Duration {
    return this.#timeoutDuration
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof TimeLimiterEvents>(type: K, listener: (event: TimeLimiterEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  metrics(): TimeLimiterMetrics {
    return { successfulCalls: this.#successful, failedCalls: this.#failed, timedOutCalls: this.#timedOut }
  }

  wrap<T, I = void>(op: Operation<T, I>): Operation<T, I> {
    const inner = lift(op)
    return mark((ctx, input) => {
      const parent = ctx.signal
      if (parent !== undefined && parent.aborted) {
        return Promise.reject(parent.reason)
      }

      // Only the owner of a controller can abort its signal, so the operation gets one of the time limiter's own,
      // combined with the caller's when there is one.
      const controller = new AbortController()
      const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal])
      const clock = this.#clock
      const start = clock.now()
      const pending = inner({ signal }, input)

      return new Promise<T>((resolve, reject) => {
        let done = false
        const finish = (): boolean => {
          if (done) {
            return false
          }
          done = true
          clock.clearTimeout(timer)
          if (parent !== undefined) {
            signal.removeEventListener('abort', onAbort)
          }
          return true
        }

        // The combined signal aborts with the caller's reason; listening there leaves the caller's signal alone.
        const onAbort = (): void => {
          if (finish()) {
            reject(signal.reason)
          }
        }

        // Not unref'd: it is what settles a call whose operation ignores its signal.
        const timer = clock.setTimeout(() => {
          if (finish()) {
            const error = new ErrTimeLimitExceeded(this.#name, this.#timeoutDuration)
            this.#timedOut++
            controller.abort(error)
            if (this.#emitter.has('timeout')) {
              this.#emitter.emit('timeout', { name: this.#name, timeoutDuration: this.#timeoutDuration })
            }
            reject(error)
          }
        }, this.#timeoutMs)

        if (parent !== undefined) {
          signal.addEventListener('abort', onAbort, { once: true })
          // An operation may abort the caller's signal while it starts, before there was a listener to hear it.
          if (signal.aborted) {
            onAbort()
          }
        }

        pending.then(
          value => {
            if (finish()) {
              this.#successful++
              if (this.#emitter.has('success')) {
                this.#emitter.emit('success', { name: this.#name, duration: clock.now() - start })
              }
              resolve(value)
            } else if (this.#discard !== undefined) {
              detached(this.#discard, value)
            }
          },
          error => {
            if (finish()) {
              this.#failed++
              if (this.#emitter.has('failure')) {
                this.#emitter.emit('failure', { name: this.#name, duration: clock.now() - start, error })
              }
              reject(error)
            }
          },
        )
      })
    })
  }
}

/**
 * Creates a {@link TimeLimiter}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function timeLimiter(options: TimeLimiterOptions): TimeLimiter {
  return new TimeLimiter(options)
}
