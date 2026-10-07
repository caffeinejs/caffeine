import { errMessage } from '@caffeinejs/std/framework'

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
 */
export class ErrAuthSchemeNotFound extends ErrCaffeineWebApplication {
  // `registered` is tolerated as absent rather than required: this constructor runs while reporting
  // another failure, and an error that throws on its way to being thrown replaces a precise diagnostic
  // with an inscrutable one.
  constructor(scheme: string, registered?: readonly string[]) {
    super(
      `Cannot resolve authentication scheme "${scheme}": no handler is registered under that name` +
        (registered === undefined
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

/**
 * ErrAuthenticationRequired is thrown at start-up when routes are protected but authentication is not
 * configured.
 *
 * Authorization is folded into the authentication hook, and configuring authentication is what binds the
 * scheme provider the hook runs. Without it a protected route would reject every caller with no scheme to
 * fault, so the application does not start.
 */
export class ErrAuthenticationRequired extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot start application: routes are protected but authentication is not configured: call ' +
        '".install(Authentication(auth => ...))" and ".with(authentication())" on the application',
      'ERR_AUTHENTICATION_REQUIRED',
    )
    this.name = 'ErrAuthenticationRequired'
  }
}

/**
 * ErrAuthenticationCookies is thrown at start-up when a gate installs on a server whose cookies are off while a scheme
 * keeps its session in a cookie: every request carrying one would fail on reading it.
 */
export class ErrAuthenticationCookies extends ErrCaffeineWebApplication {
  constructor(scheme: string) {
    super(
      errMessage(
        `Cannot start application: authentication scheme "${scheme}" keeps its session in a cookie, and cookies are ` +
          'disabled on this server',
      )
        .solutions('Turn cookies back on with ".cookie(k => k.enabled(true))"')
        .reference('@caffeinejs/http', ErrAuthenticationCookies)
        .build(),
      'ERR_AUTHENTICATION_COOKIES',
    )
    this.name = 'ErrAuthenticationCookies'
  }
}

/**
 * ErrAuthenticationGateRequired is thrown at start-up when a route requires authentication and no authentication
 * gate covers it.
 *
 * Installing `Authentication(...)` binds what a gate runs on, but only a gate authenticates a request: one
 * registered with `.with(authentication())` covers every route of the application's own server, one registered on
 * an ops server with `o.with(authentication())` covers every route of that server, and one registered on a router
 * covers that router's routes. Served with none, a protected route would answer anyone, so the application does not
 * start.
 */
export class ErrAuthenticationGateRequired extends ErrCaffeineWebApplication {
  constructor(routes: readonly string[]) {
    const one = routes.length === 1
    const named = routes
      .slice(0, 5)
      .map(route => `"${route}"`)
      .join(', ')
    const more = routes.length > 5 ? ` and ${routes.length - 5} more` : ''

    super(
      errMessage(
        `Cannot start application: ${one ? 'route' : 'routes'} ${named}${more} ${one ? 'requires' : 'require'} ` +
          `authentication and no authentication gate covers ${one ? 'it' : 'them'}`,
      )
        .solutions(
          'Register the gate on the application, where it covers every route of its own server: ' +
            '".with(authentication())"',
          'Or, for a route an ops server serves, register one on that server: ' +
            '"Ops(name, o => o.with(authentication()))"',
          'Or register one on the router holding the route: "router.plugin(authentication())"',
          'Or open the route to anyone: "@AllowAnonymous()" or ".authorize({ allowAnonymous: true })" where it ' +
            'is declared, "authenticationExempt()" as a raw route\'s config, or "exemptFromAuthentication(route)" ' +
            'from an "onRoute" hook for a route another plugin registers',
        )
        .reference('@caffeinejs/http', ErrAuthenticationGateRequired)
        .build(),
      'ERR_AUTHENTICATION_GATE_REQUIRED',
    )
    this.name = 'ErrAuthenticationGateRequired'
  }
}
