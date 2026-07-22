import type { OidcAuthenticationOptions } from '../options.js'

/** Google's OIDC issuer — also serves the discovery document at its well-known path. */
export const GOOGLE_ISSUER = 'https://accounts.google.com'

export function googleOidcPreset(
  opts: Omit<OidcAuthenticationOptions, 'discoveryUrl' | 'issuer'>,
): OidcAuthenticationOptions {
  // The issuer is pinned alongside the discovery URL, not left for the document to declare:
  // otherwise a swapped discovery response would define the issuer its own tokens are then
  // validated against.
  return { ...opts, discoveryUrl: GOOGLE_ISSUER, issuer: GOOGLE_ISSUER }
}
