/**
 * OidcError is the base error class for all errors thrown by the OIDC authentication strategy.
 *
 * `message` carries the diagnostic detail and is meant for server-side logs only.
 * `publicMessage` is what may safely be returned to the client — it must never disclose
 * token validation internals, issuer/audience values, or provider responses.
 */
export class OidcError extends Error {
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
 * ErrOidcConfiguration is thrown when the OIDC strategy is misconfigured.
 */
export class ErrOidcConfiguration extends OidcError {
  constructor(message: string) {
    super(message, 'ERR_OIDC_CONFIGURATION', 500, 'Authentication is not configured correctly')
    this.name = 'ErrOidcConfiguration'
  }
}

/**
 * ErrOidcDiscovery is thrown when the provider discovery document cannot be fetched or is invalid.
 */
export class ErrOidcDiscovery extends OidcError {
  constructor(message: string) {
    super(message, 'ERR_OIDC_DISCOVERY', 502, 'Authentication provider is unavailable')
    this.name = 'ErrOidcDiscovery'
  }
}

/**
 * ErrOidcCallback is thrown when the authorization callback cannot be completed.
 *
 * Every failure mode collapses to the same client-facing message so that state, nonce,
 * signature, and token-exchange failures are indistinguishable to an attacker probing
 * the callback endpoint.
 */
export class ErrOidcCallback extends OidcError {
  constructor(message: string) {
    super(message, 'ERR_OIDC_CALLBACK', 400, 'Authentication failed')
    this.name = 'ErrOidcCallback'
  }
}

export function isOidcError(e: unknown): e is OidcError {
  return e instanceof OidcError
}
