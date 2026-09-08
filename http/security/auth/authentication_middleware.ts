import type { FastifyContextConfig } from 'fastify'

import type { Context } from '../../context.js'
import { ErrAuthenticationNotConfigured } from '../../middleware/errors.js'
import { Middleware, type MiddlewareSetupContext, type Next } from '../../middleware/middleware.js'
import type { ActionResultTypes } from '../../response.js'
import { mergePrincipals, newAnonymousUser, type Principal } from '../index.js'
import { ErrAuthSchemeNotFound } from './errors.js'
import { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticationService } from './service.js'

/**
 * Authenticates the request and, when the route is protected, authorizes it — in that order, in one
 * middleware.
 *
 * Authorization is not separately registrable on purpose. Folding them together removes the ordering,
 * and with it the mistake of authorizing an identity nothing has established yet.
 *
 * Registered at `onRequest` (see `useAuthenticationAndAuthorization`), before the body is parsed or
 * validated: an unauthenticated caller must be answered 401, not a 400 describing the route's schema.
 */
export class Authentication extends Middleware {
  #coordinator!: AuthenticationService
  #defaultScheme!: string

  setup(ctx: MiddlewareSetupContext): void {
    // Configuring authentication binds the coordinator, and nothing else does — so its presence *is* the
    // feature being on, with no separate flag to be written and then read out of sync with it.
    const coordinator = ctx.container.getOptional(AuthenticationService)
    const registered = ctx.container.getOptional(AuthenticationSchemeProvider)
    if (coordinator === undefined || registered === undefined) {
      throw new ErrAuthenticationNotConfigured()
    }

    this.#coordinator = coordinator
    this.#defaultScheme = registered.defaultAuthenticateScheme

    // A name that resolves to nothing authenticates nobody, and the failure is invisible: the route would
    // reject every caller with no indication of why. Rejecting here means a typo is a start-up error next
    // to the decorator that caused it, not a support ticket. Validated even though `authenticate()` also
    // throws on the same condition — start-up is where a fixed, known-ahead-of-time reference belongs.
    for (const router of ctx.routeGroups) {
      for (const route of router.routes) {
        for (const scheme of route.authorization.options?.schemes ?? []) {
          if (!registered.schemeNames.includes(scheme)) {
            throw new ErrAuthSchemeNotFound(scheme, registered.schemeNames)
          }
        }
      }
    }
  }

  async handle(ctx: Context, next: Next): Promise<ActionResultTypes> {
    // `routeConfig` carries whatever the adapter recorded about the route; this middleware is registered by
    // the Fastify adapter, so that is the shape it reads.
    const route = (ctx.routeConfig as FastifyContextConfig).caffeine?.auth
    const schemes = route?.schemes
    const named = schemes !== undefined && schemes.length > 0 && route?.allowAnonymous !== true

    ctx.user = named ? await this.#authenticateNamed(ctx, schemes) : await this.#authenticateDefault(ctx)

    const authorizer = route?.authorizer
    if (authorizer == null) {
      return next()
    }

    const result = await authorizer.authorize(ctx, ctx.user)
    if (result.ok) {
      return next()
    }

    // A route that names schemes must be challenged by those, not by the application default. Otherwise a
    // Basic-protected route in a browser-first application answers with the default scheme's redirect,
    // which an API client can neither follow nor satisfy. Every named scheme gets to contribute: each
    // writes its own `WWW-Authenticate`, so a route accepting Basic or Bearer advertises both instead of
    // whichever the decorator happened to list first. An unnamed route passes `undefined` and gets the
    // default.
    const challenged: Array<string | undefined> = schemes?.length ? [...schemes] : [undefined]

    if (!ctx.user.authenticated) {
      for (const scheme of challenged) {
        await this.#coordinator.challenge(ctx, scheme)
      }
    } else {
      // Forbid is a single decision, not an advertisement: the caller is authenticated and simply not
      // permitted, so repeating it per scheme would just overwrite one 403 with another.
      await this.#coordinator.forbid(ctx, challenged[0])
    }

    // Returning without calling `next()` is what skips the handler. challenge()/forbid() only set
    // status/headers (or a redirect), so the pipeline finalizes the reply on the way out.
    return undefined
  }

  async #authenticateDefault(ctx: Context): Promise<Principal> {
    const result = await this.#coordinator.authenticate(ctx, this.#defaultScheme)
    return result.succeeded ? result.ticket!.principal : newAnonymousUser()
  }

  /**
   * Re-authenticates a route that names its own schemes, accepting those and nothing else.
   *
   * **The reset is the security-relevant part.** A route naming schemes never inherits the principal the
   * default scheme would have produced, so a caller holding a valid default-scheme credential cannot sail
   * through a route that demands something else: authorization would otherwise see an authenticated user
   * and allow it, and naming a scheme would *widen* access rather than narrow it. Anything the named
   * schemes do not accept is anonymous by the time authorization looks.
   *
   * Every named scheme runs, and every one that succeeds contributes its identities — not the first that
   * succeeds. A route naming two schemes is describing what it accepts, so which of them the caller
   * satisfied should not decide which claims the policy gets to see, and a caller presenting both
   * credentials should not have one silently discarded because of decorator ordering.
   */
  async #authenticateNamed(ctx: Context, schemes: readonly string[]): Promise<Principal> {
    let user: Principal | undefined

    for (const scheme of schemes) {
      const result = await this.#coordinator.authenticate(ctx, scheme)
      if (result.succeeded) {
        user = mergePrincipals(user, result.ticket!.principal)
      }
    }

    return user ?? newAnonymousUser()
  }
}
