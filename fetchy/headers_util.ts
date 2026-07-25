/**
 * Merges class-level default headers with method-level headers, with method-level values winning
 * on key conflicts.
 */
export function mergeHeaders(classHeaders: Headers, methodHeaders: Headers): Headers {
  const merged = new Headers(classHeaders)

  for (const [key, value] of methodHeaders.entries()) {
    merged.set(key, value)
  }

  return merged
}
