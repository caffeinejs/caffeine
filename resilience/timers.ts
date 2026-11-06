import type { Duration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { ErrInvalidOption } from './errors.js'

// The largest delay `setTimeout` honours; above it, runtimes fire after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647

/**
 * Where an instance reads the time and schedules its timers. Every factory takes one as `clock`; the default is the
 * runtime's `performance.now()` and timers. Pass one to drive time in a test, or to run on a clock of your own.
 */
export interface Clock {
  /** Milliseconds on a clock that never goes back, such as `performance.now()`. */
  now(): number
  /** Calls `callback` once, after `delay`. Whatever it returns is handed to `clearTimeout`. */
  setTimeout(callback: () => void, delay: Duration): unknown
  clearTimeout(handle: unknown): void
}

// Read once: in Node, `globalThis.performance` is a getter that costs about 12 ns a read, and the breaker reads the
// clock twice per call. The timers are read on each call, as an application's own code reads them.
const monotonic = globalThis.performance

export const systemClock: Clock = {
  now: () => monotonic.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

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
export function scheduleUnref(clock: Clock, fn: () => void, ms: number): unknown {
  const handle = clock.setTimeout(fn, ms)
  if (typeof handle === 'object' && handle !== null) {
    ;(handle as { unref?: () => unknown }).unref?.()
  }
  return handle
}
