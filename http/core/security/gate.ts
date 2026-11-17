import { ErrFeatureNotInstalled } from '@caffeinejs/application'
import type { Container } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import type { IContext } from '../../context.js'
import type { HTTPSetupContext } from '../../plugin.js'
import { ErrConfiguration } from '../error/common.js'
import type { RouteDefinition } from '../lifecycle/route_definition.js'
import type { IRoute } from '../routing/route.js'
import { ErrAuthenticationGateRequired, ErrAuthSchemeNotFound } from './auth/errors.js'
import { kAuthSchemeDescriptors } from './auth/keys.js'
import { AuthenticationSchemeProvider } from './auth/scheme_provider.js'
import { AuthenticationService } from './auth/service.js'
import type { AuthzRouteService } from './authz/route_service.js'
import { isAccessControlExempt } from './exempt.js'
import { anonymousUser, mergePrincipals, type Principal } from './identity.js'

/** What the authentication gate has to know about the route a request matched. */
export interface GatedRoute {
  schemes?: readonly string[]
  allowAnonymous: boolean
  authorizer?: AuthzRouteService
}

/** One gate's settings, resolved once its factory runs. */
export interface ResolvedGate {
  readonly label: string
  /** The gate's `defaultScheme(...)`, when it set one. */
  readonly override: string | undefined
  /** What authenticates a route that names no scheme: the override, else the application's default. */
  readonly defaultScheme: string
  readonly oidcRoutes: boolean
  readonly service: AuthenticationService
  /** A scheme that keeps its session in a cookie, or `undefined` when none does. */
  readonly cookieScheme: string | undefined
}

/**
 * Resolves a gate's options against the container, as its factory runs.
 *
 * @throws ErrFeatureNotInstalled when `Authentication(...)` is not installed.
 * @throws ErrAuthSchemeNotFound when the gate's `defaultScheme(...)` names an unregistered scheme.
 */
export function resolveGate(
  context: HTTPSetupContext<any>,
  options: { label: string; defaultScheme: string | undefined; oidcRoutes: boolean },
): ResolvedGate {
  const { label, defaultScheme: override, oidcRoutes } = options

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

  return {
    label,
    override,
    defaultScheme: override ?? schemeProvider.defaultAuthenticateScheme,
    oidcRoutes,
    service,
    cookieScheme: cookieSchemeOf(container),
  }
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

/** What a gate reads off a compiled route; `skip` for one outside access control. */
export function gatedRouteOf(route: Readonly<IRoute<any>>): { readonly skip: boolean; readonly gated: GatedRoute } {
  const options = route.authorization.options

  return {
    skip: isAccessControlExempt(route.config),
    gated: {
      schemes: options?.schemes,
      allowAnonymous: options?.allowAnonymous === true,
      authorizer: route.authorization.authorizer,
    },
  }
}

/** Which gate authenticates a route on the engine, and what it reads off the route. */
export interface GateEntry {
  /** The innermost gate: the one that authenticates the route. */
  readonly id: symbol
  readonly label: string
  readonly skip: boolean
  readonly gated: GatedRoute
  /** Every gate that covered the route, by label. */
  readonly labels: ReadonlyMap<string, symbol>
}

// Keyed by the definition, one per route and server: a GET's automatic HEAD route shares it.
const OWNERS = new WeakMap<RouteDefinition, GateEntry>()

/**
 * Records gate `id` as the owner of `route`. Hooks run outermost first, so the innermost gate's `onRoute` runs last
 * and wins.
 *
 * @throws ErrConfiguration when another gate under the same label covered the route already.
 */
export function ownRoute(route: RouteDefinition, id: symbol, label: string): void {
  const previous = OWNERS.get(route)
  const holder = previous?.labels.get(label)

  if (holder !== undefined && holder !== id) {
    throw new ErrConfiguration(
      errMessage(
        `Cannot register a second authentication gate labelled "${label}" over "${route.methods.join('|')} ` +
          `${route.url}": a gate under that label covers it already`,
      )
        .solutions(`Give the inner gate its own label: "authentication(g => g.name('admin'))"`)
        .reference('@caffeinejs/http', ErrConfiguration)
        .build(),
    )
  }

  const labels = new Map(previous?.labels)
  labels.set(label, id)
  // What the route declares does not change from one covering gate to the next.
  const { skip, gated } = previous ?? gatedRouteOf(route.route)
  OWNERS.set(route, { id, label, labels, skip, gated })
}

/** The gate that owns `route`, or `undefined` when no gate covers it. */
export function gateOf(route: RouteDefinition): GateEntry | undefined {
  return OWNERS.get(route)
}

/**
 * Refuses a protected route no gate owns: installing `Authentication(...)` is not what gates a request. A route is
 * protected when it compiled an authorizer, the fallback policy's included.
 *
 * @throws ErrAuthenticationGateRequired naming each one, one name per route: `GET|HEAD /x`.
 */
export function assertGated(
  routes: readonly {
    readonly definition: RouteDefinition
    readonly methods: readonly string[]
    readonly url: string
  }[],
): void {
  const ungated = routes
    .filter(({ definition }) => definition.route.authorization.authorizer != null && !OWNERS.has(definition))
    .map(({ methods, url }) => `${methods.join('|')} ${url}`)

  if (ungated.length > 0) {
    throw new ErrAuthenticationGateRequired(ungated)
  }
}

/**
 * Establishes `ctx.user`, then runs the route's authorization. Resolves to whether the request may go on.
 *
 * `challengeScheme` is a gate's `defaultScheme(...)` override, when it set one: a route that names no scheme
 * is then challenged by the gate's own default rather than by the application's challenge chain, so the gate
 * that authenticates a route is also the one whose scheme answers it.
 */
export async function authenticateAndAuthorize(
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
