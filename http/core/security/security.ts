import type { Container } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import type { AdapterExtensionFactory, HTTPSetupContext } from '../../adapter.js'
import type { IContext } from '../../context.js'
import { HTTPPlugin, type HTTPPluginConfigurer } from '../../plugin.js'
import { kCookieSettings } from '../cookie/keys.js'
import type { IRouteGroup } from '../routing/route.js'
import {
  ErrAuthConfiguration,
  ErrAuthenticationCookies,
  ErrAuthenticationRequired,
  ErrAuthSchemeNotFound,
} from './auth/errors.js'
import { OIDCRoutesRef } from './auth/oidc/oidc_routes_ref.js'
import { mountOIDCRoutes } from './auth/oidc/routes.js'
import { AuthenticationSchemeProvider } from './auth/scheme_provider.js'
import { AuthenticationService } from './auth/service.js'
import { authenticateAndAuthorize, gateOf, ownRoute, resolveGate, type GatedRoute, type ResolvedGate } from './gate.js'

/**
 * Refuses an application that protects a route and never configured authentication.
 *
 * Checked apart from the gate because a gate registered without the feature is already refused at its own
 * factory, and an application that never installed `Authentication(...)` is exactly the case being refused.
 *
 * @throws ErrAuthenticationRequired when a route declares protection and nothing can authenticate a caller.
 */
export function assertAuthenticationConfigured(container: Container, routeGroups: readonly IRouteGroup<any>[]): void {
  if (container.getOptional(AuthenticationService) !== undefined) {
    return
  }

  if (routeGroups.some(group => group.routes.some(route => route.authorization.hasProtection))) {
    throw new ErrAuthenticationRequired()
  }
}

/**
 * Refuses a route naming an authentication scheme the feature never registered.
 *
 * A name that resolves to nothing authenticates nobody, and the failure is invisible: the route would reject
 * every caller with no indication of why. Refusing at start-up means a typo is an error next to the decorator
 * that caused it, not a support ticket. One whole-table scan rather than a per-gate `onRoute` hook, so several
 * gates do not repeat it and it fires whether or not a gate was registered at all. With the feature off there
 * is nothing to resolve against; a protected route is then {@link assertAuthenticationConfigured}'s refusal.
 *
 * @throws ErrAuthSchemeNotFound when a compiled route names a scheme no `addX(...)` registered.
 */
export function assertRouteSchemesResolve(container: Container, routeGroups: readonly IRouteGroup<any>[]): void {
  const schemeProvider = container.getOptional(AuthenticationSchemeProvider)
  if (schemeProvider === undefined) {
    return
  }

  for (const group of routeGroups) {
    for (const route of group.routes) {
      for (const scheme of route.authorization.options?.schemes ?? []) {
        if (schemeProvider.schemeFor(scheme) === undefined) {
          throw new ErrAuthSchemeNotFound(scheme, schemeProvider.schemeNames)
        }
      }
    }
  }
}

export const kGateOptions = Symbol('caffeine.http.auth.gateOptions')

/**
 * Authors one gate's own settings. The callback runs while the factory builds the gate, handed the same
 * {@link HTTPSetupContext} the factory gets, so a setting can come from the configuration or the container.
 */
export class AuthenticationGateBuilder {
  #label = 'default'
  #defaultScheme: string | undefined
  #oidcRoutes = true

  /**
   * Names this gate: `caffeine-authentication` for the default, `caffeine-authentication:<label>` otherwise. Two
   * gates under one label are refused at start-up, in one slot or when both cover a route, so a gate inside a route
   * group under a root gate carries its own label.
   */
  name(label: string): this {
    this.#label = label
    return this
  }

  /**
   * The scheme this gate authenticates — and, when it refuses, challenges — a route that names none with,
   * overriding the application defaults for the routes this gate owns. A route naming its own schemes is
   * untouched: those authenticate and challenge it, as everywhere else.
   *
   * Documentation keeps the application default: a compiled route's effective schemes — what openapi reads —
   * state the application-wide default, not this override.
   *
   * @throws ErrAuthSchemeNotFound at start-up when no scheme is registered under `name`.
   */
  defaultScheme(name: string): this {
    this.#defaultScheme = name
    return this
  }

  /**
   * Whether this gate may claim the OIDC login and callback routes, which the first installing gate registers
   * once for the whole application. On by default. Turn it off on a gate registered inside a prefixed route
   * group: the routes would land under the group's prefix, where the identity provider's `callbackURL` never
   * arrives. On the web-standards engine only a gate on a server registers them; a router's gate that keeps them on
   * fails start-up unless a gate on its server, or on one built before it, claimed them.
   */
  oidcRoutes(enabled: boolean): this {
    this.#oidcRoutes = enabled
    return this
  }

  [kGateOptions](): { label: string; defaultScheme: string | undefined; oidcRoutes: boolean } {
    return { label: this.#label, defaultScheme: this.#defaultScheme, oidcRoutes: this.#oidcRoutes }
  }
}

/**
 * The authentication gate: authenticates the request and, when the route is protected, authorizes it, in that order,
 * in one `onRequest` hook. Requires `Authentication(...)` to be installed; the feature binds what the gate runs on.
 *
 * The hook runs at `onRequest`, before the body is parsed or validated: an unauthenticated caller is answered 401,
 * not a 400 describing the route's schema. It runs where the gate was registered among the plugins, and before the
 * guards: a plugin registered before it, such as cross-origin protection, runs first.
 *
 * Registered with `.with(authentication())`, the gate covers every route of the application's own server; with a
 * listener's `l.with(authentication())`, every route of that server; with
 * `router.with(authentication(g => g.name('admin')))`, the router's routes alone. Where several gates cover a route,
 * the innermost authenticates and challenges it, and the others stand down. Two gates under one label never cover
 * one route.
 *
 * Start-up refuses a protected route, one declaring protection or one the fallback policy reaches, when no gate
 * covers it: installing `Authentication(...)` is not what gates a request.
 *
 * The OIDC sign-in and callback routes are registered once, by the first gate on a server that keeps them on; servers
 * are built the application's own first. A gate on a router does not register them.
 *
 * @throws ErrFeatureNotInstalled at start-up when `Authentication(...)` is not installed.
 * @throws ErrAuthSchemeNotFound at start-up when the gate's `defaultScheme(...)` names an unregistered scheme.
 * @throws ErrAuthenticationCookies at start-up when a scheme keeps its session in a cookie and cookies are off.
 * @throws ErrConfiguration at start-up when two gates under one label would cover one route.
 * @throws ErrAuthConfiguration at start-up when a gate on a router keeps the OIDC routes on and no gate on its server,
 * or on a server built before it, registered them.
 */
export function authentication<C = unknown>(
  configure?: HTTPPluginConfigurer<AuthenticationGateBuilder, C>,
): AdapterExtensionFactory<HTTPPlugin, C> {
  return context => {
    const builder = new AuthenticationGateBuilder()
    configure?.(builder, context)

    return new AuthenticationGate(resolveGate(context, builder[kGateOptions]()))
  }
}

class AuthenticationGate extends HTTPPlugin {
  override readonly name: string
  readonly #gate: ResolvedGate

  constructor(gate: ResolvedGate) {
    super()
    this.#gate = gate
    this.name = gate.label === 'default' ? 'caffeine-authentication' : `caffeine-authentication:${gate.label}`
  }

  register(context: HTTPSetupContext): void {
    const { label, override, defaultScheme, oidcRoutes, service, cookieScheme } = this.#gate

    // Refused as the server starts, rather than as every request carrying the cookie failing to read it.
    if (cookieScheme !== undefined && !context.container.get(kCookieSettings).enabled) {
      throw new ErrAuthenticationCookies(cookieScheme)
    }

    if (oidcRoutes) {
      claimOIDCRoutes(context, this.name)
    }

    const id = Symbol(label)
    context.app.hook('onRoute', route => ownRoute(route, id, label))
    context.app.hook('onRequest', ctx => {
      const route = ctx.route
      // This gate's `onRoute` saw every route its `onRequest` covers: the entry names the innermost gate. A miss has
      // none, and is authenticated by the default scheme and authorized by nothing.
      const entry = route === undefined ? undefined : gateOf(route)
      if (entry !== undefined && (entry.id !== id || entry.skip)) {
        return
      }

      return gate(ctx, service, defaultScheme, entry?.gated, override)
    })
  }
}

/** Authenticates and authorizes, and sends what challenge() or forbid() set when the request may not go on. */
async function gate(
  ctx: IContext,
  service: AuthenticationService,
  defaultScheme: string,
  route: GatedRoute | undefined,
  override: string | undefined,
): Promise<void> {
  // challenge() and forbid() set the status and headers, or a redirect: an empty body sends them.
  if (!(await authenticateAndAuthorize(ctx, service, defaultScheme, route, override)) && !ctx.sent) {
    ctx.body()
  }
}

/**
 * Serves the OIDC routes from the first gate on a server that keeps them on. A router's or a controller's slot belongs
 * to no server: whether a gate on a server claimed them, on any server built so far, is known once the server this
 * router is served on is ready.
 */
function claimOIDCRoutes(context: HTTPSetupContext, gate: string): void {
  const oidc = context.container.getOptional(OIDCRoutesRef)
  if (oidc === undefined) {
    return
  }

  const server = context.app.server
  if (server !== undefined) {
    if (!oidc.claimed) {
      oidc.claimed = true
      mountOIDCRoutes(context, oidc.meta, server.basePath)
    }
    return
  }

  context.app.hook('onReady', () => {
    if (!oidc.claimed) {
      throw new ErrAuthConfiguration(
        errMessage(
          `Cannot serve the OIDC sign-in and callback routes from gate "${gate}" on a router: on the ` +
            'web-standards engine only a gate on a server registers them, and none on this server or one built ' +
            'before it did',
        )
          .solutions(
            'Register a gate on the application, whose server is built first: ".with(authentication())"',
            'Or turn them off on the router\'s gate: "authentication(g => g.oidcRoutes(false))"',
          )
          .reference('@caffeinejs/http', ErrAuthConfiguration)
          .build(),
      )
    }
  })
}
