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
  const timer = setTimeout(
    () => controller.abort(new ErrLockBackendTimeout(spec.operation, spec.key, spec.timeout, spec.bound)),
    spec.timeout,
  )
  // Never the last thing keeping a process alive.
  timer.unref?.()

  const onCallerAbort = () => controller.abort(callerSignal!.reason)
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  return new Promise<T>((resolve, reject) => {
    let pending: Promise<T> | undefined

    function settle(): void {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
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

    try {
      pending = call(signal)
    } catch (error) {
      settle()
      reject(error)
      return
    }

    // The backend may have aborted synchronously from inside `call`; its answer is then already late.
    if (signal.aborted) {
      pending.then(onLate, onLateError ?? noop).catch(onLateError ?? noop)
      return
    }

    pending.then(
      value => {
        if (signal.aborted) {
          return
        }
        settle()
        resolve(value)
      },
      (error: unknown) => {
        if (signal.aborted) {
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
