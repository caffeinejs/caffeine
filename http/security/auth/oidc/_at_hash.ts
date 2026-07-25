import { createHash, timingSafeEqual } from 'node:crypto'
import { redactPii } from '../internal/remote/pii.js'
import { ErrOIDCCallback } from './errors.js'

/**
 * Maps an id_token signing algorithm to the digest used for its hash claims.
 *
 * OIDC Core §3.1.3.6: the hash is taken with the algorithm implied by the `alg` header —
 * `RS256`/`ES256`/`PS256` use SHA-256, and so on for the 384 and 512 variants.
 */
function digestFor(alg: string): string {
  if (alg.endsWith('512')) {
    return 'sha512'
  }
  if (alg.endsWith('384')) {
    return 'sha384'
  }
  return 'sha256'
}

/**
 * Computes the OIDC hash of a token: base64url of the left-most half of its digest.
 */
export function accessTokenHash(accessToken: string, alg: string): string {
  const digest = createHash(digestFor(alg)).update(accessToken, 'ascii').digest()
  return digest.subarray(0, digest.length / 2).toString('base64url')
}

/**
 * Verifies an `at_hash` claim against the access token it is supposed to bind.
 *
 * OPTIONAL for the authorization code flow (OIDC Core §3.1.3.8) — both tokens arrive over
 * the same authenticated back-channel response, so there is no substitution channel to
 * close. Checked anyway when the provider asserts it, as a cheap guard against provider
 * misconfiguration and against a token response assembled from mismatched parts.
 */
export function assertAccessTokenHash(
  accessToken: string,
  atHash: string,
  alg: string,
  showPii = false,
): void {
  const computed = accessTokenHash(accessToken, alg)
  const expected = Buffer.from(computed)
  const actual = Buffer.from(atHash)

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ErrOIDCCallback(
      'Cannot process OIDC callback: at_hash does not match the access token'
      + ` (expected ${redactPii('at_hash', computed, showPii)},`
      + ` received ${redactPii('at_hash', atHash, showPii)})`,
    )
  }
}
