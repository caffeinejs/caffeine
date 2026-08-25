import type { FastifyReply, FastifyRequest } from 'fastify'
import { FeatureConfigurer, type RoutePhaseContext, type RouterPhaseContext } from '../../feature_configurer.js'
import { mergePrincipals, newAnonymousUser, type Principal } from '../index.js'
import { ErrAuthSchemeNotFound } from './errors.js'

/**
 * Authenticates each request, populating `req.user`.
 *
 * Two layers. Every controller scope gets a hook that runs the application's default scheme, which is what
 * makes `ctx.user` meaningful on any route. A route that names its own schemes then gets a second, per-route
 * hook that re-authenticates with exactly those — see {@link configureRoute}.
 */
export class AuthenticationConfigurer extends FeatureConfigurer {
  readonly name = 'authentication'

  configureRouter = (ctx: RouterPhaseContext): void => {
    const auth = ctx.services.auth
    if (!auth.enabled || !auth.coordinator || !auth.options) {
      return
    }

    const coordinator = auth.coordinator
    const scheme = auth.options.defaultAuthenticateScheme
    if (!scheme) {
      return
    }

    ctx.server.addHook('onRequest', async req => {
      const result = await coordinator.authenticate(req.httpContext, scheme)
      req.user = result.succeeded ? result.ticket!.principal : newAnonymousUser()
    })
  }

  /**
   * Re-authenticates a route that names its own schemes, trying them in the order given and taking the first
   * that succeeds.
   *
   * **The reset on failure is the security-relevant part.** The scope-level hook above has already
   * authenticated the *default* scheme and left its principal on the request. If this hook only overwrote
   * `req.user` on success, a caller holding a valid default-scheme credential would sail through a route that
   * demands something else entirely: authorization would see an authenticated user and allow it. Naming a
   * scheme would then *widen* access rather than narrow it. So a route that names schemes accepts those
   * schemes and nothing else, and anything else is anonymous by the time authorization looks.
   *
   * `allowAnonymous` routes are skipped: they are not gated, and clobbering the principal there would take
   * `ctx.user` away from a handler that legitimately reads it.
   */
  configureRoute = (ctx: RoutePhaseContext): void => {
    const auth = ctx.services.auth
    if (!auth.enabled || !auth.coordinator) {
      return
    }

    const options = ctx.route.authorization.options
    const schemes = options?.schemes
    if (!schemes?.length || options?.allowAnonymous === true) {
      return
    }

    // A name that resolves to nothing authenticates nobody, and the failure is invisible: the route would
    // reject every caller with no indication of why. Rejecting here means a typo is a start-up error next
    // to the decorator that caused it, not a support ticket. Validated even though `authenticate()` now
    // throws on the same condition — start-up is where a fixed, known-ahead-of-time reference belongs.
    const registered = auth.schemes
    if (registered !== undefined) {
      for (const scheme of schemes) {
        if (!registered.schemeNames.includes(scheme)) {
          throw new ErrAuthSchemeNotFound(scheme, registered.schemeNames)
        }
      }
    }

    const coordinator = auth.coordinator
    const onRequest = ctx.routeDef.onRequest as Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>>

    onRequest.push(async req => {
      let user: Principal | undefined

      // Every named scheme runs, and every one that succeeds contributes its identities — not the first
      // that succeeds. A route naming two schemes is describing what it accepts, so which of them the
      // caller satisfied should not decide which claims the policy gets to see, and a caller presenting
      // both credentials should not have one silently discarded because of decorator ordering.
      for (const scheme of schemes) {
        const result = await coordinator.authenticate(req.httpContext, scheme)
        if (result.succeeded) {
          user = mergePrincipals(user, result.ticket!.principal)
        }
      }

      req.user = user ?? newAnonymousUser()
    })
  }
}
