import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { abortReason } from '../abort.js'
import { settled, type RawNext } from '../compose.js'
import { Emitter } from '../emitter.js'
import { ErrCallRefused, ErrInvalidOption, restoreStacks, suppressStacks } from '../errors.js'
import type { ExecutionContext, Next, StrategyObject } from '../strategy.js'
import { clampDelay, clock, type TimerHandle } from '../timers.js'
import { type Waiter, Waiters } from '../waiters.js'

/**
 * A bulkhead refused the call: every slot was taken, and the call could not wait for one or waited as long as it was
 * allowed to. The operation did not run.
 */
export class ErrBulkheadFull extends ErrCallRefused {
  // Built once rather than per refusal: refusals come in bulk while a dependency is slow.
  static readonly #footer = errMessage('').reference('@caffeinejs/resilience', ErrBulkheadFull).build()

  /** The name of the bulkhead that refused the call. */
  readonly bulkhead: string

  /** `waited` is how long the call waited for a slot before it was refused; `undefined` when it could not wait. */
  constructor(bulkhead: string, maxConcurrentCalls: number, queuedCalls: number, waited?: Duration) {
    const running = `${maxConcurrentCalls} ${maxConcurrentCalls === 1 ? 'call' : 'calls'} running`
    const reason =
      waited === undefined
        ? `bulkhead is full with ${running} and ${queuedCalls} queued`
        : `no slot freed within ${formatDuration(waited)} with ${running}`
    super(`Cannot call "${bulkhead}": ${reason}${ErrBulkheadFull.#footer}`, 'ERR_BULKHEAD_FULL', undefined)
    this.name = 'ErrBulkheadFull'
    this.bulkhead = bulkhead
  }
}

export interface BulkheadOptions {
  /** Names the bulkhead in errors, events and metrics. */
  name: string
  /** Calls allowed to run at once. Defaults to 25. */
  maxConcurrentCalls?: number
  /** How long a call may wait for a slot. `0`, the default, refuses a call that finds none at once. */
  maxWaitDuration?: Duration
  /**
   * How many calls may wait for a slot at once; the next is refused at once. Used only when `maxWaitDuration` is
   * above `0`. Defaults to `maxConcurrentCalls`.
   */
  maxQueuedCalls?: number
  /** Whether a refused call's {@link ErrBulkheadFull} captures a stack trace. Off by default. */
  captureStackTrace?: boolean
}

export interface BulkheadMetrics {
  readonly availableConcurrentCalls: number
  readonly maxAllowedConcurrentCalls: number
  readonly queuedCalls: number
  /** Every call refused since the bulkhead was created. */
  readonly rejectedCalls: number
}

export interface BulkheadEvents {
  /** A call got a slot. `waited` is how long it queued for it, `0` when one was free. */
  permitted: { readonly name: string; readonly waited: Duration }
  rejected: { readonly name: string }
  /** A call that held a slot settled and gave the slot back. */
  finished: { readonly name: string; readonly duration: Duration }
}

interface QueuedCall<T> extends Waiter {
  readonly ctx: ExecutionContext
  readonly run: RawNext<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  readonly since: number
  timer: TimerHandle | undefined
  onAbort: (() => void) | undefined
}

/**
 * Limits how many calls run at once.
 *
 * A call that finds every slot taken waits in line, first come first served, for at most `maxWaitDuration`, with at
 * most `maxQueuedCalls` waiting; otherwise it is refused with {@link ErrBulkheadFull}. A waiting call whose signal
 * aborts leaves the line and rejects with the abort reason.
 *
 * A slot is given back when the rest of the chain settles, never earlier: a time limiter outside it that gave up on
 * a call does not free the slot while the operation is still running.
 */
export class Bulkhead implements StrategyObject {
  readonly #name: string
  readonly #maxConcurrentCalls: number
  readonly #maxWaitMs: number
  readonly #maxQueuedCalls: number
  readonly #captureStackTrace: boolean
  readonly #queue = new Waiters<QueuedCall<any>>()
  readonly #emitter = new Emitter<BulkheadEvents>()
  #available: number
  #rejected = 0

  constructor(options: BulkheadOptions) {
    const name = (options as Partial<BulkheadOptions> | undefined)?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new ErrInvalidOption(
        errMessage('Cannot create bulkhead: name must be a non-empty string')
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    const invalid = (reason: string): ErrInvalidOption =>
      new ErrInvalidOption(
        errMessage(`Cannot create bulkhead "${name}": ${reason}`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )

    const maxConcurrentCalls = options.maxConcurrentCalls ?? 25
    if (!Number.isInteger(maxConcurrentCalls) || maxConcurrentCalls < 1) {
      throw invalid(`maxConcurrentCalls must be an integer of at least 1, got ${String(maxConcurrentCalls)}`)
    }

    const maxWaitDuration = options.maxWaitDuration ?? 0
    if (typeof maxWaitDuration !== 'number' || !Number.isFinite(maxWaitDuration) || maxWaitDuration < 0) {
      throw invalid(`maxWaitDuration must be a finite Duration of at least 0s, got ${formatDuration(maxWaitDuration)}`)
    }

    const maxQueuedCalls = options.maxQueuedCalls ?? maxConcurrentCalls
    if (!Number.isInteger(maxQueuedCalls) || maxQueuedCalls < 0) {
      throw invalid(`maxQueuedCalls must be an integer of at least 0, got ${String(maxQueuedCalls)}`)
    }

    const captureStackTrace = options.captureStackTrace ?? false
    if (typeof captureStackTrace !== 'boolean') {
      throw invalid(`captureStackTrace must be a boolean, got ${typeof captureStackTrace}`)
    }

    this.#name = name
    this.#maxConcurrentCalls = maxConcurrentCalls
    this.#maxWaitMs = clampDelay(maxWaitDuration, `the wait of bulkhead "${name}"`)
    this.#maxQueuedCalls = maxQueuedCalls
    this.#captureStackTrace = captureStackTrace
    this.#available = maxConcurrentCalls
  }

  get name(): string {
    return this.#name
  }

  /**
   * Listens to one kind of event. Listeners run synchronously; one that throws, or returns a promise that
   * rejects, never changes the call's outcome, and its error resurfaces as uncaught on the next microtask.
   */
  on<K extends keyof BulkheadEvents>(type: K, listener: (event: BulkheadEvents[K]) => unknown): () => void {
    return this.#emitter.on(type, listener)
  }

  metrics(): BulkheadMetrics {
    return {
      availableConcurrentCalls: this.#available,
      maxAllowedConcurrentCalls: this.#maxConcurrentCalls,
      queuedCalls: this.#queue.size,
      rejectedCalls: this.#rejected,
    }
  }

  run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
    if (this.#available > 0) {
      this.#available--
      if (this.#emitter.has('permitted')) {
        this.#emitter.emit('permitted', { name: this.#name, waited: 0 })
      }

      const start = clock.now()
      // `run` is public, so `next` may be one the chain never normalised. It is called inside this frame's own `try`:
      // a helper that called it would add a frame to every stack trace.
      let pending: Promise<T>
      try {
        pending = settled((next as RawNext<T>)(ctx))
      } catch (error) {
        pending = Promise.reject(error)
      }

      return pending.then(
        value => {
          this.#release(start)
          return value
        },
        error => {
          this.#release(start)
          throw error
        },
      )
    }

    if (this.#maxWaitMs === 0 || this.#queue.size >= this.#maxQueuedCalls) {
      this.#refused()
      // Built here, in the frame that refuses, so a captured stack starts at `run` and not in a helper. Returned, not
      // thrown: throwing costs more than the rest of the refusal together.
      const queued = this.#queue.size
      return Promise.reject(
        this.#captureStackTrace
          ? new ErrBulkheadFull(this.#name, this.#maxConcurrentCalls, queued)
          : stackless(this.#name, this.#maxConcurrentCalls, queued, undefined),
      )
    }

    const signal = ctx.signal
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(abortReason(signal))
    }

    return new Promise<T>((resolve, reject) => {
      const call: QueuedCall<T> = {
        ctx,
        run: next,
        resolve,
        reject,
        since: clock.now(),
        timer: undefined,
        onAbort: undefined,
        prev: undefined,
        next: undefined,
        queued: false,
      }
      this.#queue.push(call)

      // Not unref'd: a call waiting for a slot is pending work.
      call.timer = setTimeout(() => {
        if (this.#leave(call)) {
          this.#refused()
          const queued = this.#queue.size
          reject(
            this.#captureStackTrace
              ? new ErrBulkheadFull(this.#name, this.#maxConcurrentCalls, queued, this.#maxWaitMs)
              : stackless(this.#name, this.#maxConcurrentCalls, queued, this.#maxWaitMs),
          )
        }
      }, this.#maxWaitMs)

      if (signal !== undefined) {
        call.onAbort = () => {
          if (this.#leave(call)) {
            reject(abortReason(signal))
          }
        }
        signal.addEventListener('abort', call.onAbort, { once: true })
      }
    })
  }

  // Takes a waiting call out of line and clears what it left behind. `false` when it had already left.
  #leave(call: QueuedCall<any>): boolean {
    if (!this.#queue.remove(call)) {
      return false
    }

    clearTimeout(call.timer)
    if (call.onAbort !== undefined) {
      call.ctx.signal?.removeEventListener('abort', call.onAbort)
    }
    return true
  }

  // A call that held a slot settled: the slot goes to the first in line, or back to the pool. The slot changes hands
  // before `finished` is emitted, so a listener that starts another call finds it where it is.
  #release(start: number): void {
    const duration = clock.now() - start
    const call = this.#queue.first
    if (call === undefined) {
      this.#available++
    } else {
      this.#leave(call)
    }

    if (this.#emitter.has('finished')) {
      this.#emitter.emit('finished', { name: this.#name, duration })
    }

    if (call !== undefined) {
      this.#admit(call)
    }
  }

  // Runs a call that waited for its slot. Guarded like the first attempt in `run`, and called from this frame: a
  // helper would add a frame to every stack trace.
  #admit<T>(call: QueuedCall<T>): void {
    const start = clock.now()
    if (this.#emitter.has('permitted')) {
      this.#emitter.emit('permitted', { name: this.#name, waited: start - call.since })
    }

    let pending: Promise<T>
    try {
      pending = settled(call.run(call.ctx))
    } catch (error) {
      pending = Promise.reject(error)
    }

    // Both handlers settle the caller's promise themselves and never throw.
    void pending.then(
      value => {
        this.#release(start)
        call.resolve(value)
      },
      error => {
        this.#release(start)
        call.reject(error)
      },
    )
  }

  #refused(): void {
    this.#rejected++
    if (this.#emitter.has('rejected')) {
      this.#emitter.emit('rejected', { name: this.#name })
    }
  }
}

// A refusal without a stack trace.
function stackless(
  bulkhead: string,
  maxConcurrentCalls: number,
  queuedCalls: number,
  waited: Duration | undefined,
): ErrBulkheadFull {
  const limit = suppressStacks()
  try {
    return new ErrBulkheadFull(bulkhead, maxConcurrentCalls, queuedCalls, waited)
  } finally {
    restoreStacks(limit)
  }
}

/**
 * Creates a {@link Bulkhead}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function bulkhead(options: BulkheadOptions): Bulkhead {
  return new Bulkhead(options)
}
