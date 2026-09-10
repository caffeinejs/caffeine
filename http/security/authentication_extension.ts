import { kExtensionStage, type ExtensionStage } from '@caffeinejs/std'
import type { FastifyContextConfig } from 'fastify'

import type { Context } from '../context.js'
import { ServerExtension, type ServerExtensionContext } from '../server_extension.js'
import { ErrAuthenticationRequired, ErrAuthSchemeNotFound } from './auth/errors.js'
import { AuthenticationSchemeProvider } from './auth/scheme_provider.js'
import { AuthenticationService } from './auth/service.js'
import { mergePrincipals, newAnonymousUser, type Principal } from './index.js'

/**
 * Authenticates the request and, when the route is protected, authorizes it — in that order, in one Fastify
 * `onRequest` hook.
 *
 * Authorization is not separately registrable on purpose. Folding them together removes the ordering, and
 * with it the mistake of authorizing an identity nothing has established yet.
 *
 * The hook is added at `onRequest`, before the body is parsed or validated: an unauthenticated caller must
 * be answered 401, not a 400 describing the route's schema. The extension is in the `gate` stage so the hook
 * registers behind every `default` extension — CORS in particular, whose headers a rejected cross-origin
 * request still needs on its way out.
 */
export class AuthenticationExtension extends ServerExtension {
  readonly name = 'caffeine-authentication'
  readonly [kExtensionStage]: ExtensionStage = 'gate'

  configure(ctx: ServerExtensionContext): void {
    // Configuring authentication binds the coordinator and the scheme provider, and nothing else does — so
    // their presence *is* the feature being on, with no separate flag to be written and then read out of
    // sync with it.
    const service = ctx.container.getOptional(AuthenticationService)
    const schemeProvider = ctx.container.getOptional(AuthenticationSchemeProvider)

    const anyProtected = ctx.routeGroups.some(group => group.routes.some(route => route.authorization.hasProtection))

    if (service === undefined || schemeProvider === undefined) {
      // A protected route with no scheme to run would reject every caller with nothing to point at. Refuse
      // at start-up rather than serve it.
      if (anyProtected) {
        throw new ErrAuthenticationRequired()
      }
      return
    }

    // A name that resolves to nothing authenticates nobody, and the failure is invisible: the route would
    // reject every caller with no indication of why. Rejecting here means a typo is a start-up error next to
    // the decorator that caused it, not a support ticket. Validated even though `authenticate()` also throws
    // on the same condition — start-up is where a fixed, known-ahead-of-time reference belongs.
    for (const group of ctx.routeGroups) {
      for (const route of group.routes) {
        for (const scheme of route.authorization.options?.schemes ?? []) {
          if (!schemeProvider.schemeNames.includes(scheme)) {
            throw new ErrAuthSchemeNotFound(scheme, schemeProvider.schemeNames)
          }
        }
      }
    }

    const defaultScheme = schemeProvider.defaultAuthenticateScheme

    // Callback style, not `async`: a synchronous pass still needs the authenticate promise, but keeping the
    // hook itself callback-shaped is what a hand-written Fastify hook does and matches the guard hook.
    ctx.server.addHook('onRequest', (request, reply, done) => {
      // Probe routes are answered without a context — see the adapter's onRequest hook.
      const context = request.httpContext as Context | undefined
      if (context == null) {
        done()
        return
      }

      this.#gate(context, service, defaultScheme).then(passed => {
        if (passed) {
          done()
          return
        }

        // challenge()/forbid() only set status/headers (or a redirect). Sending flushes the reply, and not
        // calling done() is what ends the lifecycle before the handler.
        if (!reply.sent) {
          reply.send()
        }
      }, done)
    })
  }

  async #gate(ctx: Context, service: AuthenticationService, defaultScheme: string): Promise<boolean> {
    // `routeConfig` carries whatever the adapter recorded about the route; this hook is added by the Fastify
    // adapter, so that is the shape it reads.
    const route = (ctx.routeConfig as FastifyContextConfig).caffeine?.auth
    const schemes = route?.schemes
    const named = schemes !== undefined && schemes.length > 0 && route?.allowAnonymous !== true

    ctx.user = named
      ? await this.#authenticateNamed(ctx, service, schemes)
      : await this.#authenticateDefault(ctx, service, defaultScheme)

    const authorizer = route?.authorizer
    if (authorizer == null) {
      return true
    }

    const result = await authorizer.authorize(ctx, ctx.user)
    if (result.ok) {
      return true
    }

    // A route that names schemes must be challenged by those, not by the application default. Otherwise a
    // Basic-protected route in a browser-first application answers with the default scheme's redirect, which
    // an API client can neither follow nor satisfy. Every named scheme gets to contribute: each writes its
    // own `WWW-Authenticate`, so a route accepting Basic or Bearer advertises both instead of whichever the
    // decorator happened to list first. An unnamed route passes `undefined` and gets the default.
    const challenged: Array<string | undefined> = schemes?.length ? [...schemes] : [undefined]

    if (!ctx.user.authenticated) {
      for (const scheme of challenged) {
        await service.challenge(ctx, scheme)
      }
    } else {
      // Forbid is a single decision, not an advertisement: the caller is authenticated and simply not
      // permitted, so repeating it per scheme would just overwrite one 403 with another.
      await service.forbid(ctx, challenged[0])
    }

    return false
  }

  async #authenticateDefault(ctx: Context, service: AuthenticationService, defaultScheme: string): Promise<Principal> {
    const result = await service.authenticate(ctx, defaultScheme)
    return result.succeeded ? result.ticket!.principal : newAnonymousUser()
  }

  /**
   * Re-authenticates a route that names its own schemes, accepting those and nothing else.
   *
   * **The reset is the security-relevant part.** A route naming schemes never inherits the principal the
   * default scheme would have produced, so a caller holding a valid default-scheme credential cannot sail
   * through a route that demands something else: authorization would otherwise see an authenticated user and
   * allow it, and naming a scheme would *widen* access rather than narrow it. Anything the named schemes do
   * not accept is anonymous by the time authorization looks.
   *
   * Every named scheme runs, and every one that succeeds contributes its identities — not the first that
   * succeeds. A route naming two schemes is describing what it accepts, so which of them the caller satisfied
   * should not decide which claims the policy gets to see, and a caller presenting both credentials should
   * not have one silently discarded because of decorator ordering.
   */
  async #authenticateNamed(
    ctx: Context,
    service: AuthenticationService,
    schemes: readonly string[],
  ): Promise<Principal> {
    let user: Principal | undefined

    for (const scheme of schemes) {
      const result = await service.authenticate(ctx, scheme)
      if (result.succeeded) {
        user = mergePrincipals(user, result.ticket!.principal)
      }
    }

    return user ?? newAnonymousUser()
  }
}
