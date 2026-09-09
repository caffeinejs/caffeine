/**
 * Shared bodies for the `env` / `either` escape hatches on {@link Configuration} and {@link ConfigSlice}, so
 * the fall-back contract reads the same from either class.
 */

/** Reads `process.env[name]`, or `fallback` when it is unset. No coercion, no key transform. */
export function readEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback
}

/** Runs `selector` against `subject`; returns `alternative` when it throws or yields `null` / `undefined`. */
export function coalesce<C, R, A>(subject: C, selector: (c: C) => R, alternative: A): NonNullable<R> | A {
  try {
    const value = selector(subject)
    return value == null ? alternative : value
  } catch {
    return alternative
  }
}
