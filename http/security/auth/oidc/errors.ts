import { RemoteAuthenticationError } from '../internal/remote/errors.js'

/**
 * ErrOIDCConfiguration is thrown when the OIDC strategy is misconfigured.
 *
 * Protocol-generic configuration failures — TLS on endpoints, cookie naming, session secret
 * strength — raise `ErrOAuthConfiguration` from the shared core instead. Both extend
 * `RemoteAuthenticationError`, so the adapter collapses either to the same client response.
 */
export class ErrOIDCConfiguration extends RemoteAuthenticationError {
  constructor(message: string) {
    super(message, 'ERR_OIDC_CONFIGURATION', 500, 'Authentication is not configured correctly')
    this.name = 'ErrOIDCConfiguration'
  }
}

/**
 * ErrOIDCDiscovery is thrown when the provider discovery document cannot be fetched or is invalid.
 */
export class ErrOIDCDiscovery extends RemoteAuthenticationError {
  /**
   * Whether the provider could not be asked at all — unreachable, answering with an error status, or with a body
   * that is not JSON — as opposed to having answered with a document that was refused.
   */
  readonly unreachable: boolean

  constructor(message: string, options?: { unreachable?: boolean }) {
    super(message, 'ERR_OIDC_DISCOVERY', 502, 'Authentication provider is unavailable')
    this.name = 'ErrOIDCDiscovery'
    this.unreachable = options?.unreachable ?? false
  }
}

/**
 * ErrOIDCCallback is thrown when the authorization callback cannot be completed.
 *
 * Every failure mode collapses to the same client-facing message so that state, nonce,
 * signature, and token-exchange failures are indistinguishable to an attacker probing
 * the callback endpoint.
 */
export class ErrOIDCCallback extends RemoteAuthenticationError {
  constructor(message: string) {
    super(message, 'ERR_OIDC_CALLBACK', 400, 'Authentication failed')
    this.name = 'ErrOIDCCallback'
  }
}

/**
 * ErrOIDCSession is thrown when a presented session cookie cannot be read.
 *
 * Expired, tampered with, sealed under a different secret, or a state cookie replayed as a
 * session. Never surfaces to the client: the authentication result falls back to anonymous
 * and the authorization layer decides what to do.
 */
export class ErrOIDCSession extends RemoteAuthenticationError {
  constructor(message: string) {
    super(message, 'ERR_OIDC_SESSION', 401, 'Authentication required')
    this.name = 'ErrOIDCSession'
  }
}

export {
  isRemoteAuthenticationError as isOIDCError,
  RemoteAuthenticationError as OIDCError,
} from '../internal/remote/errors.js'
