import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Opaque series identifier: 128 bits is ample for a lookup key. */
export function newSeries(): string {
  return randomBytes(16).toString('base64url')
}

/** Remember-me token: the bearer secret, 256 bits. */
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

export function formatRemember(series: string, token: string): string {
  return `${series}:${token}`
}

export function parseRemember(cookie: string): { series: string, token: string } | null {
  const sep = cookie.indexOf(':')
  if (sep <= 0 || sep === cookie.length - 1) {
    return null
  }
  return { series: cookie.slice(0, sep), token: cookie.slice(sep + 1) }
}
