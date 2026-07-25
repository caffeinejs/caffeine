import type { OIDCAuthenticationOptions } from '../options.js'

/** Google's OIDC issuer — also serves the discovery document at its well-known path. */
export const GOOGLE_ISSUER = 'https://accounts.google.com'

export function googleOIDCPreset(
  opts: Omit<OIDCAuthenticationOptions, 'discoveryURL' | 'issuer'>,
): OIDCAuthenticationOptions {
  // The issuer is pinned alongside the discovery URL, not left for the document to declare:
  // otherwise a swapped discovery response would define the issuer its own tokens are then
  // validated against.
  return { ...opts, discoveryURL: GOOGLE_ISSUER, issuer: GOOGLE_ISSUER }
}
