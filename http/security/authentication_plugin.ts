import type { Container } from '@caffeinejs/di'
import type { FastifyContextConfig, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import type { Context } from '../context.js'
import type { RouteGroup } from '../route.js'
import { ErrAuthenticationRequired, ErrAuthSchemeNotFound } from './auth/errors.js'
import { AuthenticationSchemeProvider } from './auth/scheme_provider.js'
import { AuthenticationService } from './auth/service.js'
import { mergePrincipals, newAnonymousUser, type Principal } from './index.js'

/**
 * Refuses an application that protects a route and never configured authentication.
 *
 * Checked apart from the gate because the gate exists only when `.authentication(...)` was called, and an
 * application that never called it is exactly the case being refused.
 *
 * @throws ErrAuthenticationRequired when a route declares protection and nothing can authenticate a caller.
 */
export function assertAuthenticationConfigured(container: Container, routeGroups: readonly RouteGroup<any>[]): void {
  if (container.getOptional(AuthenticationService) !== undefined) {
    return
  }

  if (routeGroups.some(group => group.routes.some(route => route.authorization.hasProtection))) {
    throw new ErrAuthenticationRequired()
  }
}

/**
 * Authenticates the request and, when the route is protected, authorizes it — in that order, in one Fastify
 * `onRequest` hook.
 *
 * Authorization is not separately registrable on purpose. Folding them together removes the ordering, and
 * with it the mistake of authorizing an identity nothing has established yet.
 *
 * The hook is added at `onRequest`, before the body is parsed or validated: an unauthenticated caller must
 * be answered 401, not a 400 describing the route's schema. Where the hook lands among the others is where
 * `.authentication(...)` was written: a plugin extended before it — CORS, whose headers a rejected
 * cross-origin request still needs on its way out — runs first, and one extended after it does not run for
 * a request the gate rejected.
 */
export function authenticationPlugin(): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async instance => {
    const container = instance.$container

    // Configuring authentication binds the coordinator and the scheme provider, and nothing else does — so
    // their presence *is* the feature being on, with no separate flag to be written and then read out of
    // sync with it.
    const service = container.getOptional(AuthenticationService)
    const schemeProvider = container.getOptional(AuthenticationSchemeProvider)

    if (service === undefined || schemeProvider === undefined) {
      return
    }

    // A name that resolves to nothing authenticates nobody, and the failure is invisible: the route would
    // reject every caller with no indication of why. Rejecting here means a typo is a start-up error next
    // to the decorator that caused it, not a support ticket. Validated even though `authenticate()` also
    // throws on the same condition — start-up is where a fixed, known-ahead-of-time reference belongs.
    instance.addHook('onRoute', options => {
      for (const scheme of options.config?.$caffeine?.route.authorization.options?.schemes ?? []) {
        if (!schemeProvider.schemeNames.includes(scheme)) {
          throw new ErrAuthSchemeNotFound(scheme, schemeProvider.schemeNames)
        }
      }
    })

    const gate = new AuthenticationGate()
    const defaultScheme = schemeProvider.defaultAuthenticateScheme

    // Callback style, not `async`: a synchronous pass still needs the authenticate promise, but keeping the
    // hook itself callback-shaped is what a hand-written Fastify hook does and matches the guard hook.
    instance.addHook('onRequest', (request, reply, done) => {
      // Probe routes are answered without a context — see the adapter's onRequest hook.
      const context = request.httpContext as Context | undefined
      if (context == null) {
        done()
        return
      }

      gate.run(context, service, defaultScheme).then(passed => {
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

  return fp(plugin, { name: 'caffeine-authentication' })
}

/** The per-request decision, kept off the plugin so the authenticate helpers stay private to it. */
class AuthenticationGate {
  async run(ctx: Context, service: AuthenticationService, defaultScheme: string): Promise<boolean> {
    // `routeConfig` carries whatever the adapter recorded about the route; this hook is added by the Fastify
    // adapter, so that is the shape it reads.
    const route = (ctx.routeConfig as FastifyContextConfig).$caffeine?.auth
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
