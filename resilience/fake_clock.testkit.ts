import { vi } from 'vitest'

// The object the package captured at load. Vitest's fake timers install a different one on globalThis and leave
// this one alone, so its `now` is routed to theirs.
const captured = globalThis.performance

export function useFakeClock(options?: Parameters<typeof vi.useFakeTimers>[0]): void {
  vi.useFakeTimers(options)
  vi.spyOn(captured, 'now').mockImplementation(() => globalThis.performance.now())
}
