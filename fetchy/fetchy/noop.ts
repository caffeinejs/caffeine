/**
 * Placeholder body for decorated methods. Verb decorators replace the method body entirely, so
 * this is never actually executed — it only satisfies the declared return type at compile time.
 */
export function noop<T>(..._args: unknown[]): T {
  return undefined as T
}
