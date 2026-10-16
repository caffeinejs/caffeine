import type { Container } from '@caffeinejs/di'

import type { IRouteGroup } from '../routing/route.js'
import { ErrAuthenticationRequired, ErrAuthSchemeNotFound } from './auth/errors.js'
import { AuthenticationSchemeProvider } from './auth/scheme_provider.js'
import { AuthenticationService } from './auth/service.js'

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
   * Names this gate. The label distinguishes the gate's `fastify-plugin` registration —
   * `caffeine-authentication` for the default, `caffeine-authentication:<label>` otherwise — so a second gate
   * on one registration chain (a scoped gate under a root one) must carry its own label, and an accidental
   * duplicate is refused at start-up instead of authenticating every request twice.
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
   * arrives.
   */
  oidcRoutes(enabled: boolean): this {
    this.#oidcRoutes = enabled
    return this
  }

  [kGateOptions](): { label: string; defaultScheme: string | undefined; oidcRoutes: boolean } {
    return { label: this.#label, defaultScheme: this.#defaultScheme, oidcRoutes: this.#oidcRoutes }
  }
}
