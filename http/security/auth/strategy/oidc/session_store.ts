import type { Claim } from '../../../index.js'
import { signCookie, verifyCookie } from './_signed_cookie.js'

export interface OidcSession {
  claims: Array<{ type: string, value: unknown, issuer: string }>
  scheme: string
}

export function claimsToSession(claims: Claim[], scheme: string): OidcSession {
  return {
    claims: claims.map(c => ({ type: c.type, value: c.value, issuer: c.issuer })),
    scheme,
  }
}

export async function encodeSession(
  value: OidcSession,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return signCookie(
    value as unknown as Record<string, unknown>,
    'oidc-session+jwt',
    secret,
    ttlSeconds,
  )
}

export async function decodeSession(cookie: string, secret: string): Promise<OidcSession> {
  return verifyCookie<OidcSession>(cookie, 'oidc-session+jwt', secret)
}
