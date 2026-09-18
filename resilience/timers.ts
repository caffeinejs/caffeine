import { ErrInvalidOption } from './errors.js'

// The largest delay `setTimeout` honours; above it, runtimes fire after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647

export type TimerHandle = ReturnType<typeof setTimeout>

// Captured once: in Node, `globalThis.performance` is a getter that costs about 14 ns a read, and the breaker reads
// the clock twice per call.
export const clock: { now(): number } = globalThis.performance

export function clampDelay(ms: number, what: string): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new ErrInvalidOption(`Cannot schedule ${what}: delay must be a finite number, got ${String(ms)}`)
  }

  return ms < 0 ? 0 : ms > MAX_TIMER_MS ? MAX_TIMER_MS : ms
}

// A timer that does not keep the process alive where the runtime supports that; browser timers are numbers.
export function scheduleUnref(fn: () => void, ms: number): TimerHandle {
  const handle = setTimeout(fn, ms)
  ;(handle as { unref?: () => unknown }).unref?.()
  return handle
}
