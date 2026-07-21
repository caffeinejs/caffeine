import { signCookie, verifyCookie } from './_signed_cookie.js'

export interface OidcState {
  state: string
  nonce: string
  codeVerifier: string
  pkceMethod: 'S256' | 'plain'
  returnTo: string
}

/** The authorization round-trip must complete within this window. */
export const STATE_TTL_SECONDS = 600

export async function encodeState(value: OidcState, secret: string): Promise<string> {
  return signCookie(
    value as unknown as Record<string, unknown>,
    'oidc-state+jwt',
    secret,
    STATE_TTL_SECONDS,
  )
}

export async function decodeState(cookie: string, secret: string): Promise<OidcState> {
  return verifyCookie<OidcState>(cookie, 'oidc-state+jwt', secret)
}
