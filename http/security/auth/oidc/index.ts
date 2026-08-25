export { type RemoteChallengeMode } from '../internal/remote/handler.js'
export { generateCodeChallenge, generateCodeVerifier, selectPKCEMethod } from '../internal/remote/pkce.js'
export {
  claimsToSession,
  decodeSession,
  decodeTicketRef,
  encodeSession,
  encodeTicketRef,
  type RemoteAuthenticationSession,
} from '../internal/remote/session_store.js'
export { decodeState, encodeState, type RemoteAuthenticationState, STATE_TTL_SECONDS } from '../internal/remote/state_store.js'
export { type RemoteAuthenticationTicket, type RemoteAuthenticationTicketStore } from '../internal/remote/ticket_store.js'
export { fetchDiscovery, type OIDCDiscoveryDocument } from './discovery.js'
export {
  ErrOIDCCallback,
  ErrOIDCConfiguration,
  ErrOIDCDiscovery,
  ErrOIDCSession,
  isOIDCError,
  OIDCError,
} from './errors.js'
export { OIDCAuthenticationHandler } from './handler.js'
export {
  assertSecureEndpoint,
  isSafeReturnPath,
  MIN_SESSION_SECRET_LENGTH,
  type OIDCAuthenticationOptions,
  OIDCAuthenticationOptionsBuilder,
  type OIDCTokens,
  type ResolvedOIDCAuthenticationOptions,
  resolveOIDCOptions,
  sanitizeSchemeName,
  type TokenEndpointAuthMethod,
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
  readonly schemeName: string
  readonly sessionCookieName: string
  readonly stateCookieName: string
  processCallback(ctx: Context): Promise<void>
}

export interface OIDCHandlerEntry {
  callbackPath: string
  handler: OAuthCallbackHandler
}

export interface OIDCMeta {
  handlers: OIDCHandlerEntry[]
}
