import type { Clock } from './timers.js'

// Reads the globals on every call, so an instance given it runs on Vitest's fake timers, `performance` included.
export const fakeTimersClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
