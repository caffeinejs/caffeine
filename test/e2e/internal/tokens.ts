import { type JWTAuthenticationOptionsBuilder, JWTService } from '@caffeinejs/http'
import { SignJWT } from 'jose'

/**
 * Locally minted HS256 access tokens, for the specs whose subject is authorization rather than where a token
 * comes from. The secret is long enough for HS256 (RFC 7518 §3.2 asks for at least the hash size).
 */

const SECRET = 'e2e-hs256-secret-with-more-than-32-bytes-of-text'
const ISSUER = 'https://issuer.e2e.test'
const AUDIENCE = 'e2e-api'

const signer = new JWTService({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' })

/** Configures a JWT bearer scheme that accepts what {@link bearer} mints. */
export function localJWT(j: JWTAuthenticationOptionsBuilder): JWTAuthenticationOptionsBuilder {
  return j.secret(SECRET).issuer(ISSUER).audience(AUDIENCE)
}

/**
 * A correctly signed token for the right issuer and audience that never expires, minted with `jose` directly
 * because no issuer worth the name would hand one out.
 */
export async function bearerWithoutExpiry(subject: string): Promise<string> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .sign(new TextEncoder().encode(SECRET))

  return `Bearer ${token}`
}

/** An `Authorization` header value for `subject`, carrying `claims` next to it. */
export async function bearer(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
  return `Bearer ${await signer.sign(claims, { subject })}`
}
