export { fetchDiscovery, type OIDCDiscoveryDocument } from './discovery.js'
export { ErrOIDCCallback, ErrOIDCConfiguration, ErrOIDCDiscovery, ErrOIDCSession } from './errors.js'
export { OIDCAuthenticationHandler } from './handler.js'
export {
  type OIDCAuthenticationOptions,
  OIDCAuthenticationOptionsBuilder,
  type OIDCTokens,
  type ResolvedOIDCAuthenticationOptions,
  resolveOIDCOptions,
} from './options.js'
export { GOOGLE_ISSUER, googleOIDCPreset } from './provider/google.js'

import type { Context } from '../../../context.js'

/**
 * The callback surface the adapter needs, satisfied by every OAuth-family handler.
 *
 * Structural rather than a concrete class so the OpenID Connect and plain OAuth 2.0 handlers
 * register their callback routes and pass startup uniqueness checks through one path.
 */
export interface OAuthCallbackHandler {
  readonly callbackPath: string
  readonly loginPath: string
  readonly schemeName: string
  readonly sessionCookieName: string
  readonly stateCookieName: string
  processCallback(ctx: Context): Promise<void>
  startSignIn(ctx: Context): Promise<void>
}

export interface OIDCHandlerEntry {
  callbackPath: string
  handler: OAuthCallbackHandler
}

export interface OIDCMeta {
  handlers: OIDCHandlerEntry[]
  /**
   * OAuth strategies that no request can reach unless a route names them.
   *
   * The builder can tell which strategies are neither the default nor selectable through a Forward
   * default, but not which routes name schemes — only the router phase sees those. So it reports the
   * candidates and the configurer, which does see the routes, decides whether any are genuinely dead.
   */
  unreachableCandidates: string[]
}
