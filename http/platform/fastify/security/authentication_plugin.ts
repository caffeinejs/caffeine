import type { Container } from '@caffeinejs/di'
import { ErrFeatureNotInstalled } from '@caffeinejs/std'
import type { FastifyPluginAsync, FastifyRequest, RouteOptions } from 'fastify'
import fp from 'fastify-plugin'

import type { IContext } from '../../../context.js'
import {
  ErrAuthenticationCookies,
  ErrAuthenticationGateRequired,
  ErrAuthenticationRequired,
  ErrAuthSchemeNotFound,
} from '../../../core/security/auth/errors.js'
import { AuthenticationGates } from '../../../core/security/auth/gates.js'
import { kAuthSchemeDescriptors } from '../../../core/security/auth/keys.js'
import { OIDCRoutesRef } from '../../../core/security/auth/oidc/oidc_routes_ref.js'
import { AuthenticationSchemeProvider } from '../../../core/security/auth/scheme_provider.js'
import { AuthenticationService } from '../../../core/security/auth/service.js'
import { AuthenticationGateBuilder, kGateOptions } from '../../../core/security/authentication_gate.js'
import { kAuthzHandlers, kAuthzOpts } from '../../../core/security/authz/keys.js'
import { newPolicyEvaluator } from '../../../core/security/authz/policy.js'
import { AuthzRouteService } from '../../../core/security/authz/route_service.js'
import { anonymousUser, mergePrincipals, type Principal } from '../../../core/security/identity.js'
import { hasServerCookies } from '../cookie/plugin.js'
import type { HTTPPluginConfigurer, HTTPPluginFactory } from '../plugin.js'
import { type GatedRoute } from '../routing/route_config.js'
import { oidcRoutesPlugin } from './auth/oidc/oidc_routes.js'

/** A route as it registered: its options, and the server context it registered on. */
export interface RegisteredRoute {
  /** Read once every route has registered: a later `onRoute` hook may still write the route's `$caffeine`. */
  readonly route: RouteOptions
  /** As the route registered: Fastify rewrites a prefixed `/` route's `url` without running the hooks again. */
  readonly url: string
  readonly method: string | readonly string[]
  readonly context: object
}

/**
 * Refuses a route a gate would authorize when no gate covers it.
 *
 * Installing `Authentication(...)` without a gate is supported — an application that only issues tokens — but a
 * protected route no gate stands in front of would answer anyone. A route is protected when the gate would run an
 * authorizer on it: the one its declaration compiled to, or the fallback policy for a route that declared nothing.
 * It is covered by a gate installed on the context it registered in, or on one above it, unless another gate owns
 * it — that one must cover it then. Where a gate sits among the plugins does not matter.
 *
 * Called once every route has registered, when every gate has stamped the routes it owns.
 *
 * @throws ErrAuthenticationRequired when a route is protected and authentication was never installed.
 * @throws ErrAuthenticationGateRequired when a protected route has no gate over it.
 */
export function assertRoutesGated(container: Container, registered: readonly RegisteredRoute[]): void {
  const fallback = fallbackFor(container)
  const gates = container.getOptional(AuthenticationGates)?.installed ?? []
  // Keyed by URL, so a GET route's HEAD twin — a route of its own — is named once, as `GET|HEAD`.
  const ungated = new Map<string, Set<string>>()

  for (const { route, url, method, context } of registered) {
    const meta = route.config?.$caffeine
    if (meta?.skipAuthentication === true || (meta?.auth ?? fallback?.forPath(url))?.authorizer == null) {
      continue
    }

    const owner = meta?.gateOwner
    const covered = gates.some(
      gate =>
        (gate.context === context || Object.prototype.isPrototypeOf.call(gate.context, context)) &&
        (owner === undefined || owner === gate.id),
    )

    if (!covered) {
      const methods = ungated.get(url) ?? new Set<string>()
      for (const name of [method].flat()) {
        methods.add(name)
      }
      ungated.set(url, methods)
    }
  }

  if (ungated.size === 0) {
    return
  }

  if (container.getOptional(AuthenticationService) === undefined) {
    throw new ErrAuthenticationRequired()
  }

  throw new ErrAuthenticationGateRequired(Array.from(ungated, ([url, methods]) => `${[...methods].join('|')} ${url}`))
}

/**
 * The authentication gate: authenticates the request and, when the route is protected, authorizes it — in
 * that order, in one Fastify `onRequest` hook. Requires `Authentication(...)` to be installed; the feature
 * binds what the gate runs on.
 *
 * Authorization is not separately registrable on purpose. Folding them together removes the ordering, and
 * with it the mistake of authorizing an identity nothing has established yet.
 *
 * The hook is added at `onRequest`, before the body is parsed or validated: an unauthenticated caller must
 * be answered 401, not a 400 describing the route's schema. Where the hook lands among the others is where
 * this gate was registered: a plugin registered before it — CORS, whose headers a rejected cross-origin
 * request still needs on its way out — runs first, and one registered after it does not run for a request
 * the gate rejected.
 *
 * Registered with `.with(authentication())`, the gate joins the application's own server and covers every route
 * it serves, wherever it sits among the plugins; registered with a listener's `l.with(authentication())`, it
 * covers that server's routes the same way. With `router.with(authentication(g => g.name('admin')))` it joins
 * that route group alone, covering exactly the group's routes. Each gate stamps the routes registered in its
 * context after it, and where several gates cover a route the last stamp — the innermost gate's, for a group's own
 * routes — decides which one authenticates and challenges it. A raw route registered straight on the server
 * declares nothing, so the fallback policy decides it when the application set one.
 *
 * Start-up refuses a route a gate would authorize — one declaring protection, or one the fallback policy reaches
 * — when no gate covers it: installing `Authentication(...)` is not what gates a request.
 *
 * A scheme reading its credential from a cookie needs no ordering care: cookies are parsed when first read, so
 * whatever slot this lands in finds them.
 *
 * @throws ErrFeatureNotInstalled at start-up when `Authentication(...)` is not installed.
 * @throws ErrAuthenticationCookies at start-up when a scheme keeps its session in a cookie and the server the gate
 * installs on has cookies off. A scheme `addStrategy` resolves from a container key is not built at start-up to be
 * asked: its first cookie read throws `ErrCookiesDisabled` instead.
 * @throws ErrAuthSchemeNotFound at start-up when the gate's `defaultScheme(...)` names an unregistered scheme.
 */
export function authentication<C = unknown>(
  configure?: HTTPPluginConfigurer<AuthenticationGateBuilder, C>,
): HTTPPluginFactory<C> {
  return context => {
    const builder = new AuthenticationGateBuilder()
    configure?.(builder, context)

    const { label, defaultScheme: override, oidcRoutes } = builder[kGateOptions]()

    // Factories run at start-up: a gate registered without the feature is a boot failure naming the fix,
    // never a server that quietly authenticates nobody.
    if (!context.hasFeature('auth')) {
      throw new ErrFeatureNotInstalled(
        'auth',
        'Install authentication on the application: ".install(Authentication(a => a.addJWTBearer(...)))"',
      )
    }

    const container = context.container
    const service = container.get(AuthenticationService)
    const schemeProvider = container.get(AuthenticationSchemeProvider)

    if (override !== undefined && schemeProvider.schemeFor(override) === undefined) {
      throw new ErrAuthSchemeNotFound(override, schemeProvider.schemeNames)
    }

    const defaultScheme = override ?? schemeProvider.defaultAuthenticateScheme
    const fallback = fallbackFor(container)
    const cookieScheme = cookieSchemeOf(container)
    const gates = container.get(AuthenticationGates)
    const gateID = Symbol(label)

    const plugin: FastifyPluginAsync = async instance => {
      // Refused as the server starts, rather than as every request carrying the cookie failing to read it.
      if (cookieScheme !== undefined && !hasServerCookies(instance)) {
        throw new ErrAuthenticationCookies(cookieScheme)
      }

      // Where this gate reaches, for the start-up check that refuses a protected route no gate covers.
      gates.installed.push({ id: gateID, context: instance })

      // The routes register once, claimed by the first gate to install — with a root gate that is always the
      // root, since root slots load before any route group registers.
      const oidc = oidcRoutes ? container.getOptional(OIDCRoutesRef) : undefined
      if (oidc !== undefined && !oidc.claimed) {
        oidc.claimed = true
        await instance.register(oidcRoutesPlugin(oidc.meta))
      }

      // Ownership stamp: hook chains run parent-first, so on a route covered by several gates the innermost
      // gate's assignment lands last and wins — a plain assignment, deliberately not `??=`.
      instance.addHook('onRoute', route => {
        const meta = route.config?.$caffeine
        if (meta !== undefined) {
          meta.gateOwner = gateID
        }
      })

      // Callback style, not `async`: a synchronous pass still needs the authenticate promise, but keeping the
      // hook itself callback-shaped is what a hand-written Fastify hook does and matches the guard hook.
      instance.addHook('onRequest', (request, reply, done) => {
        // Absent only on the not-found context, which Fastify builds directly rather than as a route, so no
        // `onRoute` hook ever stamped it. That falls to the fallback below, whose own `is404` check answers it —
        // and answers it the way it always did, by authenticating and authorizing nothing.
        const meta = request.routeOptions.config.$caffeine

        if (meta?.skipAuthentication === true) {
          done()
          return
        }

        // A route another gate owns is that gate's to authenticate and challenge; standing down keeps it to
        // one authentication per request whatever order the gates' hooks run in.
        if (meta?.gateOwner !== undefined && meta.gateOwner !== gateID) {
          done()
          return
        }

        const route = meta?.auth ?? fallback?.for(request)

        authenticateAndAuthorize(request.httpContext, service, defaultScheme, route, override).then(passed => {
          if (passed) {
            done()
            return
          }

          // challenge()/forbid() only set status/headers (or a redirect). Sending flushes the reply, and not
          // calling done() is what ends the lifecycle before the handler. A scheme that answered for itself has
          // already sent, which `reply.sent` does not yet show while an `onSend` hook holds that send open.
          if (!request.httpContext.sent) {
            reply.send()
          }
        }, done)
      })
    }

    return fp(plugin, {
      name: label === 'default' ? 'caffeine-authentication' : `caffeine-authentication:${label}`,
    })
  }
}

/** The fallback policy as it applies to a route the application's router did not compile. */
interface Fallback {
  /** For the route a request matched. */
  for(request: FastifyRequest): GatedRoute | undefined
  /** For the route registered under `path`, which is how start-up asks. */
  forPath(path: string): GatedRoute | undefined
}

/** A scheme that keeps its session in a cookie, or `undefined` when none does. */
function cookieSchemeOf(container: Container): string | undefined {
  // Bound by the `auth` feature, which the factory has already found installed.
  for (const [name, descriptor] of container.get(kAuthSchemeDescriptors)) {
    if (descriptor.in === 'cookie') {
      return name
    }
  }

  return undefined
}

/** The application's {@link Fallback}, or `undefined` when it set no fallback policy. */
function fallbackFor(container: Container): Fallback | undefined {
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
  const except = options.fallbackExcept.map(prefix => {
    const exact = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix

    return { exact, under: `${exact}/` }
  })

  const forPath = (path: string): GatedRoute | undefined =>
    except.some(({ exact, under }) => path === exact || path.startsWith(under)) ? undefined : gated

  return {
    for(request) {
      // A URL nothing matched has no route, so there is no route policy to apply: the not-found handler answers
      // it, for anyone. What a policy protects is a route, and an unknown URL is not one.
      if (request.is404) {
        return undefined
      }

      // The path the route was registered under, not the URL that was requested: no spelling of a URL can then
      // borrow the exemption of a route it did not match.
      return forPath(request.routeOptions.url!)
    },
    forPath,
  }
}

/**
 * Establishes `ctx.user`, then runs the route's authorization. Resolves to whether the request may go on.
 *
 * `challengeScheme` is a gate's `defaultScheme(...)` override, when it set one: a route that names no scheme
 * is then challenged by the gate's own default rather than by the application's challenge chain, so the gate
 * that authenticates a route is also the one whose scheme answers it.
 */
async function authenticateAndAuthorize(
  ctx: IContext,
  service: AuthenticationService,
  defaultScheme: string,
  route: GatedRoute | undefined,
  challengeScheme?: string,
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
  // an API client can neither follow nor satisfy. An unnamed route passes the gate's override, or `undefined`
  // for the application's own challenge chain.
  const challenged: Array<string | undefined> = schemes?.length ? [...schemes] : [challengeScheme]

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
  ctx: IContext,
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
  ctx: IContext,
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
