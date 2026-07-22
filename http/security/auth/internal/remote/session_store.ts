import type { Claim } from '../../../index.js'
import { sealCookie, unsealCookie } from './_sealed_cookie.js'

export interface RemoteAuthenticationSession {
  claims: Array<{ type: string, value: unknown, issuer: string }>
  scheme: string
}

/**
 * Asserts that a value retrieved from a ticket store is a well-formed session.
 *
 * The inline session cookie is sealed and unsealed by this package, so its shape is trusted.
 * A ticket store, by contrast, is supplied by the deployment and its serializer is outside our
 * control: a round-trip that drops the empty claims array, or returns a partially-deserialized
 * row, must fail closed as an authentication failure rather than throw out of `authenticate`
 * on the later `claims.map`, which would bypass the fail path and 500 every request that
 * carries the cookie.
 */
export function assertValidSession(value: unknown): asserts value is RemoteAuthenticationSession {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('ticket store returned a session that is not an object')
  }
  const session = value as { scheme?: unknown, claims?: unknown }
  if (typeof session.scheme !== 'string' || session.scheme.length === 0) {
    throw new TypeError('ticket store returned a session with no scheme')
  }
  if (!Array.isArray(session.claims)) {
    throw new TypeError('ticket store returned a session whose claims are not an array')
  }
}

export function claimsToSession(claims: Claim[], scheme: string): RemoteAuthenticationSession {
  return {
    claims: claims.map(c => ({ type: c.type, value: c.value, issuer: c.issuer })),
    scheme,
  }
}

export async function encodeSession(
  value: RemoteAuthenticationSession,
  secret: string,
  scheme: string,
  ttlSeconds: number,
): Promise<string> {
  return sealCookie(
    value as unknown as Record<string, unknown>,
    'oidc-session+jwt',
    secret,
    scheme,
    ttlSeconds,
  )
}

export async function decodeSession(
  cookie: string,
  secret: string,
  scheme: string,
): Promise<RemoteAuthenticationSession> {
  return unsealCookie<RemoteAuthenticationSession>(cookie, 'oidc-session+jwt', secret, scheme)
}

/**
 * The cookie payload when an `OidcTicketStore` is configured: an opaque key and nothing else.
 *
 * Sealed under its own purpose rather than left bare. The key carries no user data, so this
 * is not for confidentiality — it is for expiry, tamper-evidence, and to keep the two cookie
 * shapes from ever standing in for one another. Each purpose and strategy derives an
 * independent key, so an inline session cookie cannot be replayed as a reference, or the
 * reverse, and neither crosses between strategies.
 */
export async function encodeTicketRef(
  key: string,
  secret: string,
  scheme: string,
  ttlSeconds: number,
): Promise<string> {
  return sealCookie({ key }, 'oidc-ticket+jwt', secret, scheme, ttlSeconds)
}

export async function decodeTicketRef(
  cookie: string,
  secret: string,
  scheme: string,
): Promise<string> {
  const { key } = await unsealCookie<{ key?: unknown }>(cookie, 'oidc-ticket+jwt', secret, scheme)
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Ticket reference cookie is missing its key')
  }
  return key
}
