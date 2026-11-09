import { addAbortListener } from 'node:events'

import type { Duration } from '@caffeinejs/std/duration'

import { ErrLockBackendTimeout } from './errors.js'

/** The backend call a lock operation makes. */
export type StoreOperation = 'acquire' | 'extend' | 'release'

/**
 * What set a backend call's deadline: the `storeTimeout` option, or the lease's own `ttl` or remaining validity
 * when that was shorter, since an answer arriving after it would carry a lease already gone.
 */
export type StoreTimeoutBound = 'storeTimeout' | 'ttl'

/** The backend call {@link boundedCall} runs, and the deadline it runs under. */
export interface StoreCall {
  readonly operation: StoreOperation
  readonly key: string
  readonly timeout: Duration
  readonly bound: StoreTimeoutBound
  /** The caller's signal. Its abort stops the wait as the deadline does, and rejects with its reason. */
  readonly signal?: AbortSignal
}

/**
 * Runs one backend call under a deadline and the caller's signal.
 *
 * Rejects with {@link ErrLockBackendTimeout} when `timeout` elapses first, with `signal.reason` when the caller's
 * signal aborts first, and with whatever the call rejected with otherwise. A call that settles after the caller
 * stopped waiting is handed to `onLate`, so a lease acquired too late can be given back. A late rejection goes to
 * `onLateError`; without it, it is swallowed. Never an unhandled rejection. Nothing outlives the call: the timer
 * and the listeners go when it settles.
 *
 * The deadline is read off a monotonic clock as well as kept by a timer: an answer that arrives once it passed is
 * late even when the timer has yet to fire, as it is when the call itself blocked the event loop past it.
 */
export function boundedCall<T>(
  spec: StoreCall,
  call: (signal: AbortSignal) => Promise<T>,
  onLate?: (value: T) => void,
  onLateError?: (error: unknown) => void,
): Promise<T> {
  const callerSignal = spec.signal
  if (callerSignal?.aborted === true) {
    return Promise.reject(callerSignal.reason)
  }

  const controller = new AbortController()
  const { signal } = controller
  const deadline = performance.now() + spec.timeout
  const timeOut = () => controller.abort(new ErrLockBackendTimeout(spec.operation, spec.key, spec.timeout, spec.bound))
  const timer = setTimeout(timeOut, spec.timeout)
  // Never the last thing keeping a process alive.
  timer.unref?.()

  // Not `addEventListener`: another listener on the caller's signal calling `stopImmediatePropagation()` would
  // keep this one from running, and the call would go on after its caller aborted.
  const callerAbort =
    callerSignal === undefined ? undefined : addAbortListener(callerSignal, () => controller.abort(callerSignal.reason))

  return new Promise<T>((resolve, reject) => {
    let pending: Promise<T> | undefined

    function settle(): void {
      clearTimeout(timer)
      callerAbort?.[Symbol.dispose]()
      signal.removeEventListener('abort', onAbort)
    }

    // Registered ahead of the backend's own listener, so a backend that rejects with the same reason lands on a
    // promise already settled, and its answer goes to the late hooks instead.
    function onAbort(): void {
      settle()
      reject(signal.reason)
      pending?.then(onLate, onLateError ?? noop).catch(onLateError ?? noop)
    }

    signal.addEventListener('abort', onAbort, { once: true })

    // A call that throws instead of rejecting is a rejection like any other.
    pending = Promise.try(call, signal)

    // The backend may have aborted synchronously from inside `call`; its answer is then already late.
    if (signal.aborted) {
      pending.then(onLate, onLateError ?? noop).catch(onLateError ?? noop)
      return
    }

    // Past the deadline, the answer is late whether or not the timer has fired: aborting hands it to the late
    // hooks through `onAbort`, as the timer would have.
    function overdue(): boolean {
      if (!signal.aborted && performance.now() >= deadline) {
        timeOut()
      }
      return signal.aborted
    }

    pending.then(
      value => {
        if (overdue()) {
          return
        }
        settle()
        resolve(value)
      },
      (error: unknown) => {
        if (overdue()) {
          return
        }
        settle()
        reject(error)
      },
    )
  })
}

function noop(): void {
  return undefined
}
