import { SignJWT, jwtVerify } from 'jose'

/**
 * Explicit media type carried in the JOSE `typ` header of every OIDC cookie token.
 *
 * The state and session cookies are signed with the same secret, so without a purpose
 * marker a state token would be a structurally valid session token. RFC 8725 §3.11
 * ("Use Explicit Typing") puts that marker in the header rather than the payload, which
 * also keeps it from colliding with a provider claim of the same name.
 */
export type OidcTokenPurpose = 'oidc-state+jwt' | 'oidc-session+jwt'

const ALGORITHMS = ['HS256']

export async function signCookie(
  payload: Record<string, unknown>,
  purpose: OidcTokenPurpose,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: purpose })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key)
}

export async function verifyCookie<T>(
  cookie: string,
  purpose: OidcTokenPurpose,
  secret: string,
): Promise<T> {
  const key = new TextEncoder().encode(secret)
  // jose enforces the typ header itself and fails closed on a mismatch.
  const { payload } = await jwtVerify(cookie, key, { algorithms: ALGORITHMS, typ: purpose })
  return payload as unknown as T
}
