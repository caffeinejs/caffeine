import { createHash, randomBytes } from 'node:crypto'
import { ErrOidcConfiguration } from './errors.js'

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
      throw new ErrOidcConfiguration(
        'Cannot configure OIDC: provider advertises only the "plain" PKCE method — '
        + 'enable allowPlainPkce to accept it',
      )
    }

    return 'plain'
  }

  return 'S256'
}
