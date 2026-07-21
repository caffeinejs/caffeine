import type { OidcAuthenticationOptions } from '../options.js'

/** Google's OIDC issuer — also serves the discovery document at its well-known path. */
export const GOOGLE_ISSUER = 'https://accounts.google.com'

export function googleOidcPreset(
  opts: Omit<OidcAuthenticationOptions, 'discoveryUrl'>,
): OidcAuthenticationOptions {
  return { ...opts, discoveryUrl: GOOGLE_ISSUER }
}
