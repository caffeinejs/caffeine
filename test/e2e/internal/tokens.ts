import { JWTService } from '@caffeinejs/http'

import type { JWTOptionsBuilder } from './builders.js'

/**
 * Locally minted HS256 access tokens, for the specs whose subject is authorization rather than where a token
 * comes from. The secret is long enough for HS256 (RFC 7518 §3.2 asks for at least the hash size).
 */

const SECRET = 'e2e-hs256-secret-with-more-than-32-bytes-of-text'
const ISSUER = 'https://issuer.e2e.test'
const AUDIENCE = 'e2e-api'

const signer = new JWTService({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' })

/** Configures a JWT bearer scheme that accepts what {@link bearer} mints. */
export function localJWT(j: JWTOptionsBuilder): JWTOptionsBuilder {
  return j.secret(SECRET).issuer(ISSUER).audience(AUDIENCE)
}

/** An `Authorization` header value for `subject`, carrying `claims` next to it. */
export async function bearer(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
  return `Bearer ${await signer.sign(claims, { subject })}`
}
