import { sealCookie, unsealCookie } from './_sealed_cookie.js'

export interface RemoteAuthenticationState {
  state: string
  nonce: string
  codeVerifier: string
  pkceMethod: 'S256' | 'plain'
  returnTo: string
  /**
   * The strategy that issued this state, and the issuer it was issued against.
   *
   * Bound into the payload as well as the key, so a callback delivered to the wrong handler
   * — or against a provider reconfigured mid-flight — is rejected rather than completed with
   * another strategy's credentials.
   */
  scheme: string
  issuer: string
}

/** The authorization round-trip must complete within this window. */
export const STATE_TTL_SECONDS = 600

export async function encodeState(
  value: RemoteAuthenticationState,
  secret: string,
  scheme: string,
): Promise<string> {
  return sealCookie(
    value as unknown as Record<string, unknown>,
    'oidc-state+jwt',
    secret,
    scheme,
    STATE_TTL_SECONDS,
  )
}

export async function decodeState(
  cookie: string,
  secret: string,
  scheme: string,
): Promise<RemoteAuthenticationState> {
  return unsealCookie<RemoteAuthenticationState>(cookie, 'oidc-state+jwt', secret, scheme)
}
