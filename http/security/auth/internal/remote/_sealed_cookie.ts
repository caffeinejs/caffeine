import { sealJWT, sealingKey, unsealJWT } from '../sealed_jwt.js'

/**
 * What a cookie of the OAuth-family strategies is for, carried as the token's `typ` and folded into its key.
 *
 * Two axes of separation. Purpose means a token sealed as state cannot be opened as a session even if the `typ`
 * check were bypassed: the wrong purpose fails at the key before the claim check runs. Strategy means two handlers
 * sharing one `sessionSecret` cannot read each other's cookies at all, so a session minted by one identity
 * provider is inert at the other. The builder refuses two schemes under one name, which is what keeps this
 * namespace unique across protocols without the protocol appearing in it.
 */
export type OIDCTokenPurpose = 'oidc-state+jwt' | 'oidc-session+jwt' | 'oidc-ticket+jwt'

const info = (purpose: OIDCTokenPurpose, scheme: string) => `caffeine:oidc:${purpose}:${scheme}`

export function keyFor(secret: string, purpose: OIDCTokenPurpose, scheme: string): Promise<CryptoKey> {
  return sealingKey(secret, info(purpose, scheme))
}

export function sealCookie(
  payload: Record<string, unknown>,
  purpose: OIDCTokenPurpose,
  secret: string,
  scheme: string,
  ttlSeconds: number,
): Promise<string> {
  return sealJWT(payload, purpose, secret, info(purpose, scheme), ttlSeconds)
}

export function unsealCookie<T>(cookie: string, purpose: OIDCTokenPurpose, secret: string, scheme: string): Promise<T> {
  return unsealJWT<T>(cookie, purpose, secret, info(purpose, scheme))
}
