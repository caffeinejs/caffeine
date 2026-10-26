import { errMessage } from '@caffeinejs/std/err'

import { abortReason } from './abort.js'
import { ErrInvalidOption } from './errors.js'

// The largest delay `setTimeout` honours; above it, runtimes fire after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647

export type TimerHandle = ReturnType<typeof setTimeout>

// Captured once: in Node, `globalThis.performance` is a getter that costs about 14 ns a read, and the breaker reads
// the clock twice per call.
export const clock: { now(): number } = globalThis.performance

export function clampDelay(ms: number, what: string): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new ErrInvalidOption(
      errMessage(`Cannot schedule ${what}: delay must be a finite number, got ${String(ms)}`)
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }

  return ms < 0 ? 0 : ms > MAX_TIMER_MS ? MAX_TIMER_MS : ms
}

// A timer that does not keep the process alive where the runtime supports that; browser timers are numbers.
export function scheduleUnref(fn: () => void, ms: number): TimerHandle {
  const handle = setTimeout(fn, ms)
  ;(handle as { unref?: () => unknown }).unref?.()
  return handle
}

// Resolves after `ms`, or rejects with the abort reason as soon as the signal aborts. Leaves no timer and no
// listener behind either way. The timer keeps the process alive: a pending retry is pending work.
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(abortReason(signal))
  }

  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
