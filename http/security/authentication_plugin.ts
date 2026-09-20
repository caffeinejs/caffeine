import type { Container } from '@caffeinejs/di'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import type { Context } from '../context.js'
import type { RouteGroup } from '../route.js'
import { ErrAuthenticationCookies, ErrAuthenticationRequired, ErrAuthSchemeNotFound } from './auth/errors.js'
import { kAuthenticationExempt } from './auth/keys.js'
import { AuthenticationSchemeProvider } from './auth/scheme_provider.js'
import { AuthenticationService } from './auth/service.js'
import { kAuthzHandlers, kAuthzOpts } from './authz/keys.js'
import { newPolicyEvaluator } from './authz/policy.js'
import { AuthzRouteService } from './authz/route_service.js'
import { anonymousUser, mergePrincipals, type Principal } from './index.js'

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

/** What the builder knows about the schemes it registered, and the gate cannot find out for itself. */
export interface AuthenticationPluginOptions {
  /**
   * Whether a registered scheme reads its credential from a cookie. Such a scheme needs `@fastify/cookie` to have
   * parsed the request before the gate runs, which is a matter of what was registered first.
   */
  readsCookies: boolean
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
 *
 * A route registered straight on the server is gated too, by the fallback policy when the application set one.
 * It carries no `@Authorize` anyone could have forgotten, so nothing else would stand in front of it.
 *
 * @throws ErrAuthenticationCookies when a scheme reads cookies and `@fastify/cookie` is not registered yet.
 */
export function authenticationPlugin(options: AuthenticationPluginOptions): FastifyPluginAsync {
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

    // Decorations appear as plugins register, so this also says `@fastify/cookie` came first — which it has to,
    // since hooks run in registration order and it parses the cookies in one of its own.
    if (options.readsCookies && !instance.hasRequestDecorator('cookies')) {
      throw new ErrAuthenticationCookies()
    }

    // A name that resolves to nothing authenticates nobody, and the failure is invisible: the route would
    // reject every caller with no indication of why. Rejecting here means a typo is a start-up error next
    // to the decorator that caused it, not a support ticket.
    instance.addHook('onRoute', route => {
      for (const scheme of route.config?.$caffeine?.route.authorization.options?.schemes ?? []) {
        if (schemeProvider.schemeFor(scheme) === undefined) {
          throw new ErrAuthSchemeNotFound(scheme, schemeProvider.schemeNames)
        }
      }
    })

    const defaultScheme = schemeProvider.defaultAuthenticateScheme
    const fallback = fallbackFor(container)

    // Callback style, not `async`: a synchronous pass still needs the authenticate promise, but keeping the
    // hook itself callback-shaped is what a hand-written Fastify hook does and matches the guard hook.
    instance.addHook('onRequest', (request, reply, done) => {
      const config = request.routeOptions.config

      if (config[kAuthenticationExempt] === true) {
        done()
        return
      }

      const route = config.$caffeine === undefined ? fallback?.for(request) : config.$caffeine.auth

      authenticateAndAuthorize(request.httpContext, service, defaultScheme, route).then(passed => {
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

/** What the gate has to know about the route a request matched. */
interface GatedRoute {
  schemes?: readonly string[]
  allowAnonymous: boolean
  authorizer?: AuthzRouteService
}

/**
 * The fallback policy as it applies to a route the application's router did not compile, or `undefined` when the
 * application set none.
 */
function fallbackFor(container: Container): { for(request: FastifyRequest): GatedRoute | undefined } | undefined {
  const options = container.getOptional(kAuthzOpts)
  if (options?.fallbackPolicy === undefined) {
    return undefined
  }

  const gated: GatedRoute = {
    allowAnonymous: false,
    authorizer: new AuthzRouteService([newPolicyEvaluator(options.fallbackPolicy, container.get(kAuthzHandlers))]),
  }
  // A prefix is a run of whole segments, written with or without its trailing slash: the path itself, and what is
  // under it. Compared as plain text, `/assets` would open `/assets-old` as well.
  const except = (options.fallbackExcept ?? []).map(prefix => {
    const exact = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

    return { exact, under: `${exact}/` }
  })

  return {
    for(request) {
      // A URL nothing matched is answered by the not-found handler, which is where a single-page application's
      // shell is served from. Gating it would turn a login page that is a client-side route into a redirect loop.
      if (request.is404) {
        return undefined
      }

      // The path the route was registered under, not the URL that was requested: no spelling of a URL can then
      // borrow the exemption of a route it did not match.
      const path = request.routeOptions.url ?? ''

      return except.some(({ exact, under }) => path === exact || path.startsWith(under)) ? undefined : gated
    },
  }
}

/** Establishes `ctx.user`, then runs the route's authorization. Resolves to whether the request may go on. */
async function authenticateAndAuthorize(
  ctx: Context,
  service: AuthenticationService,
  defaultScheme: string,
  route: GatedRoute | undefined,
): Promise<boolean> {
  const schemes = route?.schemes
  const named = schemes !== undefined && schemes.length > 0 && route?.allowAnonymous !== true

  ctx.user = named
    ? await authenticateNamed(ctx, service, schemes)
    : await authenticateDefault(ctx, service, defaultScheme)

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
  // an API client can neither follow nor satisfy. An unnamed route passes `undefined` and gets the default.
  const challenged: Array<string | undefined> = schemes?.length ? [...schemes] : [undefined]

  if (!ctx.user.authenticated) {
    // Every named scheme gets to contribute, each appending its own `WWW-Authenticate`, so a route accepting
    // Basic or Bearer advertises both. A scheme that answers the request itself — a redirect to a login page, a
    // body — has taken the response: one after it would turn the redirect back into a 401, or write to a reply
    // that already left.
    for (const scheme of challenged) {
      await service.challenge(ctx, scheme)

      if (ctx.sent || (ctx.statusCode >= 300 && ctx.statusCode < 400)) {
        break
      }
    }
  } else {
    // Forbid is a single decision, not an advertisement: the caller is authenticated and simply not
    // permitted, so repeating it per scheme would just overwrite one 403 with another.
    await service.forbid(ctx, challenged[0])
  }

  return false
}

async function authenticateDefault(
  ctx: Context,
  service: AuthenticationService,
  defaultScheme: string,
): Promise<Principal> {
  const result = await service.authenticate(ctx, defaultScheme)
  return result.succeeded ? result.ticket!.principal : anonymousUser()
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
async function authenticateNamed(
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

  return user ?? anonymousUser()
}
