import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Shared "series + token" primitives for durable, rotating, server-side-revocable credentials. Used by
// the cookie remember-me guard and the bearer refresh-token grant. The `series` is an opaque lookup
// key; the `token` is the bearer secret (only its hash is ever stored).

/** Opaque series identifier: 128 bits is ample for a lookup key. */
export function newSeries(): string {
  return randomBytes(16).toString('base64url')
}

/** Bearer secret token: 256 bits. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hash a token for at-rest storage. A fast hash suffices — the token is high-entropy random. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** Constant-time compare of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token))
  const b = Buffer.from(storedHash)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Encode `series` and `token` into a single opaque string (`series:token`). */
export function formatToken(series: string, token: string): string {
  return `${series}:${token}`
}

/** Split a `series:token` string on the first colon. Returns null for malformed input. */
export function parseToken(value: string): { series: string; token: string } | null {
  const sep = value.indexOf(':')
  if (sep <= 0 || sep === value.length - 1) {
    return null
  }
  return { series: value.slice(0, sep), token: value.slice(sep + 1) }
}
