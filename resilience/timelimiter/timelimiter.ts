import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { abortReason } from '../abort.js'
import { settled } from '../compose.js'
import { Emitter } from '../emitter.js'
import { ErrInvalidOption, ErrResilience } from '../errors.js'
import type { ExecutionContext, Next, StrategyObject } from '../strategy.js'
import { clampDelay, clock } from '../timers.js'

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
 * The rest of the chain gets a signal of its own, linked to the caller's. When the limit passes, that signal aborts
 * with an {@link ErrTimeLimitExceeded} and the call rejects with it at once, even if the operation ignores its
 * signal and never settles. When the caller aborts first, the call rejects with the caller's reason. An outcome that
 * arrives after the call settled is dropped.
 *
 * Its place in the chain decides what it bounds: inside a retry, each attempt; outside it, every attempt and every
 * wait between them.
 */
export class TimeLimiter implements StrategyObject {
  readonly #name: string
  readonly #timeoutDuration: Duration
  readonly #timeoutMs: number
  readonly #emitter = new Emitter<TimeLimiterEvents>()
  #successful = 0
  #failed = 0
  #timedOut = 0

  constructor(options: TimeLimiterOptions) {
    const name = (options as Partial<TimeLimiterOptions> | undefined)?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new ErrInvalidOption(
        errMessage('Cannot create time limiter: name must be a non-empty string')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    const timeoutDuration = options.timeoutDuration
    if (typeof timeoutDuration !== 'number' || !Number.isFinite(timeoutDuration) || timeoutDuration <= 0) {
      throw new ErrInvalidOption(
        errMessage(
          `Cannot create time limiter "${name}": timeoutDuration must be a finite Duration greater than 0s, got ${formatDuration(timeoutDuration)}`,
        )
          .solutions('Pass the longest the call may take, such as timeoutDuration: 2 * Second')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    this.#name = name
    this.#timeoutDuration = timeoutDuration
    this.#timeoutMs = clampDelay(timeoutDuration, `time limiter "${name}"`)
  }

  get name(): string {
    return this.#name
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

  run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
    const parent = ctx.signal
    if (parent !== undefined && parent.aborted) {
      return Promise.reject(abortReason(parent))
    }

    const controller = new AbortController()
    const start = clock.now()
    // `run` is public, so `next` may be one the chain never normalised. It is called inside this frame's own `try`:
    // a helper that called it would add a frame to every stack trace.
    let pending: Promise<T>
    try {
      pending = settled(next(ctx.with({ signal: controller.signal })))
    } catch (error) {
      pending = Promise.reject(error)
    }

    return new Promise<T>((resolve, reject) => {
      let settledAlready = false
      const finish = (): boolean => {
        if (settledAlready) {
          return false
        }
        settledAlready = true
        clearTimeout(timer)
        parent?.removeEventListener('abort', onAbort)
        return true
      }

      const onAbort = (): void => {
        if (finish()) {
          const reason = abortReason(parent!)
          controller.abort(reason)
          reject(reason)
        }
      }

      // Not unref'd: it is what settles a call whose operation ignores its signal.
      const timer = setTimeout(() => {
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
        parent.addEventListener('abort', onAbort, { once: true })
        // An operation may abort the caller's signal while `next` runs, before there was a listener to hear it.
        if (parent.aborted) {
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
