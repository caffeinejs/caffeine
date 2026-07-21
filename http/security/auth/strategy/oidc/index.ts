export { fetchDiscovery, type OidcDiscoveryDocument } from './discovery.js'
export { ErrOidcCallback, ErrOidcConfiguration, ErrOidcDiscovery, isOidcError, OidcError } from './errors.js'
export { OidcAuthenticationHandler } from './handler.js'
export {
  assertSecureEndpoint,
  isSafeReturnPath,
  MIN_SESSION_SECRET_LENGTH,
  type OidcAuthenticationOptions,
  OidcAuthenticationOptionsBuilder,
  type OidcTokens,
  type ResolvedOidcAuthenticationOptions,
  resolveOidcOptions,
  type TokenEndpointAuthMethod,
} from './options.js'
export { generateCodeChallenge, generateCodeVerifier, selectPkceMethod } from './pkce.js'
export { GOOGLE_ISSUER, googleOidcPreset } from './provider/google.js'
export { claimsToSession, decodeSession, encodeSession, type OidcSession } from './session_store.js'
export { decodeState, encodeState, type OidcState, STATE_TTL_SECONDS } from './state_store.js'

import type { OidcAuthenticationHandler } from './handler.js'

export const kOidcMeta: unique symbol = Symbol('caffeinejs.oidc.meta')

export interface OidcHandlerEntry {
  callbackPath: string
  handler: OidcAuthenticationHandler
}

export interface OidcMeta {
  handlers: OidcHandlerEntry[]
}
