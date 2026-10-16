/**
 * Base error for every OAuth 2.0 and OpenID Connect strategy.
 *
 * `message` carries the diagnostic detail and is meant for server-side logs only.
 * `publicMessage` is what may safely be returned to the client — it must never disclose
 * token validation internals, issuer/audience values, or provider responses.
 */
export class RemoteAuthenticationError extends Error {
  readonly code: string
  readonly statusCode: number
  readonly publicMessage: string

  constructor(message: string, code: string, statusCode: number, publicMessage: string) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.publicMessage = publicMessage
  }
}

/**
 * ErrOAuthConfiguration is thrown when a strategy is misconfigured.
 *
 * Raised by the checks that are protocol-generic — cookie naming, TLS on endpoints, session
 * secret strength — so both the OIDC and the plain OAuth 2.0 handler share them.
 */
export class ErrOAuthConfiguration extends RemoteAuthenticationError {
  constructor(message: string) {
    super(message, 'ERR_OAUTH_CONFIGURATION', 500, 'Authentication is not configured correctly')
    this.name = 'ErrOAuthConfiguration'
  }
}

/**
 * ErrOAuthCallback is thrown when the authorization callback cannot be completed.
 *
 * Every failure mode collapses to the same client-facing message so that state, signature and
 * token-exchange failures are indistinguishable to an attacker probing the callback endpoint.
 */
export class ErrOAuthCallback extends RemoteAuthenticationError {
  constructor(message: string) {
    super(message, 'ERR_OAUTH_CALLBACK', 400, 'Authentication failed')
    this.name = 'ErrOAuthCallback'
  }
}

/**
 * ErrOAuthSession is thrown when a presented session cookie cannot be read.
 *
 * Expired, tampered with, sealed under a different secret or strategy, or revoked. Never
 * surfaces to the client: the authentication result falls back to anonymous and the
 * authorization layer decides what to do.
 */
export class ErrOAuthSession extends RemoteAuthenticationError {
  constructor(message: string) {
    super(message, 'ERR_OAUTH_SESSION', 401, 'Authentication required')
    this.name = 'ErrOAuthSession'
  }
}

export function isRemoteAuthenticationError(e: unknown): e is RemoteAuthenticationError {
  return e instanceof RemoteAuthenticationError
}
