import { createHash, randomBytes } from 'node:crypto'
import { ErrOAuthConfiguration } from './errors.js'

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Picks the PKCE challenge method, preferring S256.
 *
 * RFC 7636 §4.4.2 and the OAuth 2.0 Security BCP require S256: `plain` sends the verifier
 * itself as the challenge and so gives no protection against code interception. A provider
 * advertising only `plain` is therefore rejected unless the caller opts in explicitly.
 */
export function selectPkceMethod(supported?: string[], allowPlain = false): 'S256' | 'plain' {
  if (!supported || supported.includes('S256')) {
    return 'S256'
  }

  if (supported.includes('plain')) {
    if (!allowPlain) {
      throw new ErrOAuthConfiguration(
        'Cannot configure authentication: provider advertises only the "plain" PKCE method — '
        + 'enable allowPlainPkce to accept it',
      )
    }

    return 'plain'
  }

  // The provider published a list and neither method is on it. Sending S256 anyway risks the
  // provider ignoring `code_challenge` outright, which silently removes PKCE from the flow —
  // the one outcome worse than refusing to start.
  throw new ErrOAuthConfiguration(
    'Cannot configure authentication: provider advertises no supported PKCE method '
    + `(advertised: ${supported.join(', ')})`,
  )
}
