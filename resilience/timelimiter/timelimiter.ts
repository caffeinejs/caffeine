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
   * it is. What it throws or rejects with is dropped too.
   *
   * The value was made under a signal that has already aborted, so a body tied to that signal has already failed and
   * let go of its connection, and `cancel()` on it rejects.
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
 * The limit counts from the call: time the operation spends before it returns, such as work before its first
 * `await`, counts too. A timer cannot interrupt that work, so a call that outruns the limit before it returns times
 * out as soon as it does. An outcome that arrives after the limit times out even when the timer has not fired yet, as
 * when the event loop was busy.
 *
 * Its place in the chain decides what it bounds: inside a retry, each attempt; outside it, every attempt and every
 * wait between them.
 */
export class TimeLimiter implements Wrapper {
  readonly #name: string
  readonly #timeoutDuration: Duration
  readonly #timeoutMs: number
  // Names the timer in a refused delay; built once, as every call clamps one.
  readonly #delayLabel: string
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
    this.#delayLabel = `time limiter "${o.name}"`
    this.#timeoutMs = clampDelay(this.#timeoutDuration, this.#delayLabel)
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
      const limit = this.#timeoutMs
      const start = clock.now()
      const attempt = { ...ctx, signal }
      if (ctx.restore !== undefined) {
        // The caller may supply a method that needs the original context as its receiver.
        attempt.restore = fn => ctx.restore!(fn)
      }
      const pending = inner(attempt, input)
      // No timer fires while the operation runs before it returns, so that time is taken off the limit here.
      const elapsed = clock.now() - start

      return new Promise<T>((resolve, reject) => {
        let done = false
        let timer: unknown
        let timing = false
        const finish = (): boolean => {
          if (done) {
            return false
          }
          done = true
          if (timing) {
            clock.clearTimeout(timer)
          }
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

        const timeOut = (): void => {
          if (finish()) {
            const error = new ErrTimeLimitExceeded(this.#name, this.#timeoutDuration)
            this.#timedOut++
            controller.abort(error)
            if (this.#emitter.has('timeout')) {
              this.#emitter.emit('timeout', { name: this.#name, timeoutDuration: this.#timeoutDuration })
            }
            reject(error)
          }
        }

        if (parent !== undefined) {
          signal.addEventListener('abort', onAbort, { once: true })
          // An operation may abort the caller's signal while it starts, before there was a listener to hear it.
          if (signal.aborted) {
            onAbort()
          }
        }

        if (elapsed > limit) {
          timeOut()
        } else if (!done) {
          // Not unref'd: it is what settles a call whose operation ignores its signal. Rounded up, so a runtime that
          // truncates delays never fires it early.
          timer = clock.setTimeout(timeOut, clampDelay(Math.ceil(limit - elapsed), this.#delayLabel))
          timing = true
        }

        // An outcome past the limit times out even before the timer fires, which a busy event loop delays: a settled
        // promise's continuation runs ahead of any timer.
        pending.then(
          value => {
            const now = clock.now()
            if (now - start > limit) {
              timeOut()
            }
            if (finish()) {
              this.#successful++
              if (this.#emitter.has('success')) {
                this.#emitter.emit('success', { name: this.#name, duration: now - start })
              }
              resolve(value)
            } else if (this.#discard !== undefined) {
              detached(this.#discard, value)
            }
          },
          error => {
            const now = clock.now()
            if (now - start > limit) {
              timeOut()
            }
            if (finish()) {
              this.#failed++
              if (this.#emitter.has('failure')) {
                this.#emitter.emit('failure', { name: this.#name, duration: now - start, error })
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
