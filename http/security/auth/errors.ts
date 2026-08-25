import { ErrCaffeineWebApplication } from '../../error/common.js'

/**
 * ErrAuthSchemeNotFound is thrown when a scheme name does not resolve to a registered handler.
 *
 * Raised at start-up where the reference is known ahead of time — a route's `schemes`, a configured
 * default — and at request time for the ones that are not, such as the scheme a Forward selector picks.
 *
 * Never silent. A scheme name that resolves to nothing authenticates nobody, so treating it as "no
 * credential presented" turns a typo into a route that rejects every caller with no indication of why,
 * or — where the route's policy does not require an identity — into one that admits them unauthenticated.
 * ASP.NET throws `InvalidOperationException` on the same condition, for the same reason.
 */
export class ErrAuthSchemeNotFound extends ErrCaffeineWebApplication {
  // `registered` is tolerated as absent rather than required: this constructor runs while reporting
  // another failure, and an error that throws on its way to being thrown replaces a precise diagnostic
  // with an inscrutable one.
  constructor(scheme: string, registered?: readonly string[]) {
    super(
      `Cannot resolve authentication scheme "${scheme}": no handler is registered under that name`
      + (registered === undefined
        ? ''
        : registered.length > 0
          ? ` (registered: ${registered.map(name => `"${name}"`).join(', ')})`
          : ' (no schemes are registered)'),
      'ERR_AUTH_SCHEME_NOT_FOUND',
    )
    this.name = 'ErrAuthSchemeNotFound'
  }
}

/**
 * ErrAuthConfiguration is thrown when the authentication builder cannot produce a usable configuration.
 *
 * Start-up only: missing defaults, contradictory registrations, a feature whose prerequisite was never
 * registered. Distinct from {@link ErrAuthSchemeNotFound}, which is specifically an unresolvable name.
 */
export class ErrAuthConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_AUTH_CONFIGURATION')
    this.name = 'ErrAuthConfiguration'
  }
}
