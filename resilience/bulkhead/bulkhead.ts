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
 * A bulkhead refused the call: every slot was taken, and the call could not wait for one or waited as long as it was
 * allowed to. The operation did not run.
 */
export class ErrBulkheadFull extends ErrCallRefused {
  /** The name of the bulkhead that refused the call. */
  readonly bulkhead: string

  /**
   * `waited` is how long the call waited for a slot before it was refused; `undefined` when it could not wait.
   * `disposed` says the wait ended because the bulkhead was disposed, not because it ran out.
   */
  constructor(bulkhead: string, maxConcurrentCalls: number, queuedCalls: number, waited?: Duration, disposed = false) {
    super(fullMessage(bulkhead, maxConcurrentCalls, queuedCalls, waited, disposed), 'ERR_BULKHEAD_FULL', undefined)
    this.name = 'ErrBulkheadFull'
    this.bulkhead = bulkhead
  }
}

// Built once rather than per refusal: refusals come in bulk while a dependency is slow.
const footer = errMessage('').reference('@caffeinejs/resilience', ErrBulkheadFull).build()

function fullMessage(
  bulkhead: string,
  maxConcurrentCalls: number,
  queuedCalls: number,
  waited: Duration | undefined,
  disposed: boolean,
): string {
  const running = `${maxConcurrentCalls} ${maxConcurrentCalls === 1 ? 'call' : 'calls'} running`
  let reason = `bulkhead is full with ${running} and ${queuedCalls} queued`
  if (waited !== undefined) {
    reason = disposed
      ? `bulkhead was disposed while the call waited ${formatDuration(waited)} for a slot`
      : `no slot freed within ${formatDuration(waited)} with ${running}`
  }
  return `Cannot call "${bulkhead}": ${reason}${footer}`
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
  /** Where the bulkhead reads the time and sets the timers of waiting calls. Defaults to the runtime's. */
  clock?: Clock
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

interface QueuedCall<T, I> extends Waiter {
  readonly ctx: CallContext
  readonly inner: Operation<T, I>
  readonly input: I
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  readonly since: number
  timer: unknown
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
export class Bulkhead implements Wrapper {
  declare [Symbol.dispose]: () => void
  readonly #name: string
  readonly #maxConcurrentCalls: number
  readonly #maxWaitMs: number
  readonly #maxQueuedCalls: number
  readonly #captureStackTrace: boolean
  readonly #clock: Clock
  readonly #queue = new Waiters<QueuedCall<any, any>>()
  readonly #emitter = new Emitter<BulkheadEvents>()
  #available: number
  #rejected = 0
  #disposed = false

  constructor(options: BulkheadOptions) {
    const o = new Options('bulkhead', options)
    this.#name = o.name
    this.#maxConcurrentCalls = o.integer('maxConcurrentCalls', options.maxConcurrentCalls ?? 25, 1)
    const maxWaitDuration = o.duration('maxWaitDuration', options.maxWaitDuration ?? 0, 0)
    this.#maxQueuedCalls = o.integer('maxQueuedCalls', options.maxQueuedCalls ?? this.#maxConcurrentCalls, 0)
    this.#captureStackTrace = o.boolean('captureStackTrace', options.captureStackTrace, false)
    this.#clock = o.clock(options.clock)
    this.#maxWaitMs = clampDelay(maxWaitDuration, `the wait of bulkhead "${o.name}"`)
    this.#available = this.#maxConcurrentCalls
  }

  get name(): string {
    return this.#name
  }

  get maxWaitDuration(): Duration {
    return this.#maxWaitMs
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

  /**
   * Refuses every call waiting for a slot now, with {@link ErrBulkheadFull}, and from then on refuses a call at once
   * where it would wait, so no wait holds a shutdown. A call that finds a free slot still starts, and running calls
   * keep theirs. The `[Symbol.dispose]` alias does the same.
   */
  dispose(): void {
    this.#disposed = true
    const now = this.#clock.now()
    const refused: Array<QueuedCall<unknown, unknown>> = []
    for (let call = this.#queue.first; call !== undefined; call = this.#queue.first) {
      this.#leave(call)
      refused.push(call)
    }

    // Refused once the line is empty, so a listener that calls back in finds it so.
    for (const call of refused) {
      this.#rejected++
      this.#refuseWaiting(call, now - call.since, true)
    }
  }

  wrap<T, I = void>(op: Operation<T, I>): Operation<T, I> {
    const inner = lift(op)
    return mark((ctx, input) => {
      if (this.#available > 0) {
        this.#available--
        if (this.#emitter.has('permitted')) {
          this.#emitter.emit('permitted', { name: this.#name, waited: 0 })
        }

        const start = this.#clock.now()
        return inner(ctx, input).then(
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

      if (this.#maxWaitMs === 0 || this.#queue.size >= this.#maxQueuedCalls || this.#disposed) {
        this.#refused()
        // Returned, not thrown: throwing costs more than the rest of the refusal together.
        return Promise.reject(this.#full(undefined))
      }

      const signal = ctx.signal
      if (signal !== undefined && signal.aborted) {
        return Promise.reject(signal.reason)
      }

      return new Promise<T>((resolve, reject) => {
        const call: QueuedCall<T, I> = {
          ctx,
          inner,
          input,
          resolve,
          reject,
          since: this.#clock.now(),
          timer: undefined,
          onAbort: undefined,
          prev: undefined,
          next: undefined,
          queued: false,
        }
        this.#queue.push(call)

        // Not unref'd: a call waiting for a slot is pending work.
        call.timer = this.#clock.setTimeout(() => {
          if (this.#leave(call)) {
            this.#rejected++
            this.#refuseWaiting(call, this.#maxWaitMs, false)
          }
        }, this.#maxWaitMs)

        if (signal !== undefined) {
          call.onAbort = () => {
            if (this.#leave(call)) {
              reject(signal.reason)
            }
          }
          signal.addEventListener('abort', call.onAbort, { once: true })
        }
      })
    })
  }

  // The refusal, with a stack trace only when asked for one.
  #full(waited: Duration | undefined, disposed = false): ErrBulkheadFull {
    const queued = this.#queue.size
    if (this.#captureStackTrace) {
      return new ErrBulkheadFull(this.#name, this.#maxConcurrentCalls, queued, waited, disposed)
    }
    return refusal(ErrBulkheadFull, fullMessage(this.#name, this.#maxConcurrentCalls, queued, waited, disposed), {
      code: 'ERR_BULKHEAD_FULL',
      name: 'ErrBulkheadFull',
      retryAfter: undefined,
      bulkhead: this.#name,
    })
  }

  // Takes a waiting call out of line and clears what it left behind. `false` when it had already left.
  #leave(call: QueuedCall<any, any>): boolean {
    if (!this.#queue.remove(call)) {
      return false
    }

    this.#clock.clearTimeout(call.timer)
    if (call.onAbort !== undefined) {
      call.ctx.signal?.removeEventListener('abort', call.onAbort)
    }
    return true
  }

  // A call that held a slot settled: the slot goes to the first in line still within its wait, or back to the pool.
  // One past its wait, whose timer has not fired yet, leaves the line refused, as that timer would have refused it.
  // The slot changes hands before `finished` is emitted, so a listener that starts another call finds it where it is.
  #release(start: number): void {
    let finished: number | undefined = start
    for (;;) {
      const now = this.#clock.now()
      let call = this.#queue.first
      let expired: Array<QueuedCall<unknown, unknown>> | undefined
      while (call !== undefined && now - call.since > this.#maxWaitMs) {
        this.#leave(call)
        expired ??= []
        expired.push(call)
        call = this.#queue.first
      }
      if (call === undefined) {
        this.#available++
      } else {
        this.#leave(call)
      }
      if (expired !== undefined) {
        this.#rejected += expired.length
      }

      if (finished !== undefined && this.#emitter.has('finished')) {
        this.#emitter.emit('finished', { name: this.#name, duration: now - finished })
      }
      finished = undefined

      if (expired !== undefined) {
        for (const refused of expired) {
          this.#refuseWaiting(refused, this.#maxWaitMs, false)
        }
      }

      if (call === undefined || this.#admit(call)) {
        return
      }
    }
  }

  // Runs a call that waited for its slot, in its caller's context.
  #admit<T, I>(call: QueuedCall<T, I>): boolean {
    const restore = call.ctx.restore
    if (restore === undefined) {
      this.#start(call)
      return true
    }
    return restoreWaitingCall(call.ctx, restore, () => this.#start(call), call.reject)
  }

  #start<T, I>(call: QueuedCall<T, I>): void {
    const start = this.#clock.now()
    if (this.#emitter.has('permitted')) {
      this.#emitter.emit('permitted', { name: this.#name, waited: start - call.since })
    }

    // Both handlers settle the caller's promise themselves and never throw.
    void call.inner(call.ctx, call.input).then(
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

  // Refuses a call that waited, in its caller's context: it is refused from a timer or another call's continuation.
  #refuseWaiting(call: QueuedCall<any, any>, waited: Duration, disposed: boolean): void {
    const restore = call.ctx.restore
    if (restore === undefined) {
      this.#reject(call, waited, disposed)
    } else {
      restoreWaitingCall(call.ctx, restore, () => this.#reject(call, waited, disposed), call.reject)
    }
  }

  #reject(call: QueuedCall<any, any>, waited: Duration, disposed: boolean): void {
    if (this.#emitter.has('rejected')) {
      this.#emitter.emit('rejected', { name: this.#name })
    }
    call.reject(this.#full(waited, disposed))
  }

  #refused(): void {
    this.#rejected++
    if (this.#emitter.has('rejected')) {
      this.#emitter.emit('rejected', { name: this.#name })
    }
  }
}

disposable(Bulkhead)

/**
 * Creates a {@link Bulkhead}.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function bulkhead(options: BulkheadOptions): Bulkhead {
  return new Bulkhead(options)
}
