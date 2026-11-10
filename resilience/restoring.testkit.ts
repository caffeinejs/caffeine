import type { CallContext } from './policy.js'

/**
 * Contexts whose `restore()` marks what runs through it with the caller it was made for, as the resilience aspect's
 * restores the caller's frame. `current()` is the caller of whatever runs now, `none` outside every `restore()`.
 */
export function restoring(): { ctxOf: (caller: string) => CallContext; current: () => string } {
  let current = 'none'
  const ctxOf = (caller: string): CallContext => {
    const context = {
      signal: undefined,
      caller,
      restore<R>(fn: () => R): R {
        const outer = current
        current = this.caller
        try {
          return fn()
        } finally {
          current = outer
        }
      },
    }
    return context
  }
  return { ctxOf, current: () => current }
}
