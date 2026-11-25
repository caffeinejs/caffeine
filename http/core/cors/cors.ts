import { formatDuration, Second, type Duration } from '@caffeinejs/std/duration'

import type { IContext } from '../../context.js'
import { HTTPPlugin, type HTTPPluginConfigurer, type HTTPPluginFactory, type HTTPSetupContext } from '../../plugin.js'
import { isServerScope } from '../../plugin_slot.js'
import { appendVary } from '../../vary.js'
import { originProblem } from '../csrf/origin.js'
import type { ErrConfiguration } from '../error/common.js'
import { ErrHTTPNotFound } from '../error/http.js'
import type { RouteDefinition } from '../lifecycle/route_definition.js'
import type { RouteOptions } from '../routing/options.js'
import { parseRoutePattern } from '../routing/paths.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { accessControlExempt } from '../security/exempt.js'
import { kRouteOf, type Context } from '../server/context.js'
import { configurationError } from '../server/error.js'
import { HEADER_NAME } from '../server/settings.js'

declare module '../routing/options.js' {
  interface RouteOptions {
    /** Read by `corsPolicy()`: this route's CORS settings over the policy's, or `false` to turn CORS off for it. */
    cors?: CORSConfig | boolean
    /** Written by `corsPolicy()`: the policy that answers for this route, `null` where CORS is off. */
    [kCORSPolicy]?: ResolvedCORS | null
    /** Marks the `OPTIONS` routes a `corsPolicy()` serves its preflights from: no preflight asks for them. */
    [kPreflightRoute]?: true
  }
}

const kCORSPolicy: unique symbol = Symbol('caffeine.http.cors.policy')
const kPreflightRoute: unique symbol = Symbol('caffeine.http.cors.preflight-route')

export const kBuild: unique symbol = Symbol('caffeine.http.cors.build')

/** One `corsPolicy()`'s settings, and what a route's `cors(...)` overrides, member by member. */
export interface CORSConfig {
  /** Exact origins, `scheme://host[:port]`, or `['*']` for any. */
  origins?: readonly string[]
  /** Sends `Access-Control-Allow-Credentials: true`. Refused with `'*'`. */
  credentials?: boolean
  /** Request headers a preflight allows. Unset: the ones it asks for. */
  allowedHeaders?: readonly string[]
  /** Response headers a page may read. */
  exposedHeaders?: readonly string[]
  /** How long a browser keeps a preflight's answer: whole seconds on the wire, at least `1 * Second`. */
  maxAge?: Duration
}

/**
 * Authors one `corsPolicy()`'s settings. The callback runs while the factory builds the plugin, handed the same
 * `HTTPSetupContext` the factory gets, so a setting can come from the configuration.
 *
 * A list method adds to its list. What a fluent method sets replaces the same member of what
 * {@link CORSBuilder.config} handed over.
 */
export class CORSBuilder {
  #config: CORSConfig | undefined
  // What the fluent methods set, each member replacing the same member of `#config`.
  readonly #set: {
    -readonly [K in keyof CORSConfig]: CORSConfig[K] extends readonly string[] | undefined ? string[] : CORSConfig[K]
  } = {}

  /** Reads the settings from a node of the configuration tree, e.g. `config.app.cors`, once, as the plugin is built. */
  config(config: CORSConfig): this {
    this.#config = config
    return this
  }

  /** The origins a browser may call from, each `scheme://host[:port]`; `'*'` alone for any. */
  origins(...origins: string[]): this {
    ;(this.#set.origins ??= []).push(...origins)
    return this
  }

  /** Lets a page send its cookies and credentials along, and read the answer. Refused with `'*'`. */
  credentials(allow = true): this {
    this.#set.credentials = allow
    return this
  }

  /** The request headers a preflight allows. Unset, a preflight allows the ones it asks for; empty, none. */
  allowedHeaders(...names: string[]): this {
    ;(this.#set.allowedHeaders ??= []).push(...names)
    return this
  }

  /** The response headers a page may read, beyond the ones every page may. */
  exposedHeaders(...names: string[]): this {
    ;(this.#set.exposedHeaders ??= []).push(...names)
    return this
  }

  /** How long a browser keeps a preflight's answer, such as `10 * Minute`: at least `1 * Second`. */
  maxAge(maxAge: Duration): this {
    this.#set.maxAge = maxAge
    return this
  }

  [kBuild](): CORSConfig {
    return overlay(this.#config ?? {}, this.#set)
  }
}

/**
 * Cross-origin resource sharing: `.with(corsPolicy(c => c.origins('https://app.example')))`.
 *
 * It names the origins a browser may call this server from. An answer to one of them says so with
 * `Access-Control-Allow-Origin`; an answer to any other carries nothing, and the browser keeps it from the page. A
 * preflight, an `OPTIONS` request carrying `Origin` and `Access-Control-Request-Method`, is answered 204 when granted:
 * from the settings of the route its path and method name, whatever constraints that route declares, `host` included.
 * Routes of one path and method that differ only by constraints share one answer: when their settings differ, their
 * preflights are refused and a warning says why. Under a `matcher` of the application's own, a preflight finds an
 * unconstrained route only. A preflight it does not grant goes on to the path's own `OPTIONS` route, or a 404. A route's
 * `cors(...)` or `@CORS(...)` replaces the plugin's settings member by member, and `cors(false)` turns CORS off for the
 * route and its preflight.
 *
 * No origin is allowed unless named: `'*'` is written, alone, and never with `credentials()`. Unless the policy is
 * `'*'`, every answer it covers varies on `Origin`. A preflight is allowed the one method it asks for, and the headers
 * it asks for unless `allowedHeaders(...)` lists them.
 *
 * It covers the routes of the scope it is registered in: a server's with `.with(...)`, a router's, or a controller's.
 * On a server it answers preflights whatever route they match, none included. On a router or a controller it serves
 * `OPTIONS /` and `OPTIONS /*` under that path, outside access control and whatever constraints the scope selects on,
 * which its preflights match: an `OPTIONS` route of the application's at either path, or a second policy on a router at
 * the same path, fails start-up with `ErrRouteConflict`, and its `OPTIONS /*` answers a plain `OPTIONS` request under
 * the path before a broader route of the application's would. An `OPTIONS` route of the application's in its scope
 * still has its preflights answered by the policy first; one outside it, such as a sibling router's, answers them
 * itself. Register it once, where it covers the routes it should, and tune a route with `cors(...)`; of two over one
 * route, the first registered decides its settings.
 *
 * The headers of an answer are set as it goes out, so a refusal by `authentication()` carries them too. When a
 * protected route declares `OPTIONS` itself, register the policy before `authentication()` in the gate's scope or an
 * outer one, so its preflights are answered first: an outer scope's hooks run before an inner one's.
 *
 * @throws ErrConfiguration at start-up for settings that name no origin or one that is not, `'*'` beside other origins
 * or with credentials, a header that is not a header name, and a `maxAge` under a second.
 * @throws ErrRouteConflict at start-up, on a router or a controller, beside an `OPTIONS` route of the application's at
 * its path, or a second policy on a router at the same path.
 */
export function corsPolicy<C = unknown>(configure?: HTTPPluginConfigurer<CORSBuilder, C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new CORSBuilder()
    configure?.(builder, context)

    // Resolved as the factory runs: a bad setting fails start-up where it was written.
    return new CORSPolicy(builder[kBuild]())
  }
}

/**
 * Sets a route's CORS settings, or every route's of a group, over `corsPolicy()`'s, member by member; `false` turns
 * CORS off for the route and its preflight. The programmatic form of `@CORS(...)`.
 */
export function cors(options: CORSConfig | boolean): Partial<RouteOptions> {
  return { cors: options }
}

const MEMBERS: ReadonlySet<string> = new Set(['origins', 'credentials', 'allowedHeaders', 'exposedHeaders', 'maxAge'])
const LISTS = ['origins', 'allowedHeaders', 'exposedHeaders'] as const

/** One policy, as a request is judged by it. */
interface ResolvedCORS {
  readonly any: boolean
  readonly origins: ReadonlySet<string>
  readonly credentials: boolean
  /** `Access-Control-Allow-Headers` as a preflight is answered; `undefined` reflects what it asks for. */
  readonly allowHeaders: string | undefined
  /** `Access-Control-Expose-Headers`; `undefined` for none. */
  readonly exposeHeaders: string | undefined
  /** `Access-Control-Max-Age`, in whole seconds; `undefined` for none. */
  readonly maxAge: string | undefined
  /** Equal settings, equal key: the origins sorted, the header lists in their order. */
  readonly key: string
}

class CORSPolicy extends HTTPPlugin {
  override readonly name = 'caffeine-cors'
  readonly #config: CORSConfig
  readonly #own: ResolvedCORS

  constructor(config: CORSConfig) {
    super()
    this.#config = config
    this.#own = resolve(config, 'build corsPolicy()')
  }

  register(context: HTTPSetupContext): void {
    // A request no route matches runs the server's own hooks, so a policy there sees every preflight. A router's or a
    // controller's sees those to its routes alone: it serves `OPTIONS` routes at its path and below for preflights to
    // match, answered in `onRequest` before their handler runs, which gives one it does not grant a path's 404. They
    // select on no constraint: a browser sends none with a preflight. A path ending in a wildcard or an optional
    // parameter has nothing below it.
    if (!isServerScope(context.server)) {
      const { prefix } = context.server
      const parts = parseRoutePattern(prefix)
      const wildcard = parts.some(part => part.kind === 'wildcard')
      const optional = parts.some(part => part.kind === 'optional')
      const preflights = new Router()

      // A group prefix of its own: its root is served with and without the trailing slash, as a prefixed router's is.
      // Nothing follows a wildcard; and a path that is one optional segment is `/` both ways without it.
      if (!wildcard && parts[0]?.kind !== 'optional') {
        preflights.extend(group => {
          group.prefix('')
        })
      }

      preflights
        .detail('http', { internal: true })
        .config(accessControlExempt(), { [kPreflightRoute]: true, constraints: null })
        .options('/', notFound)
      context.server.mount(wildcard || optional ? preflights : preflights.options('/*', notFound))
    }

    const own = this.#own
    const config = this.#config
    const warned = new WeakSet<RouteDefinition>()
    // A request no route matched has the plugin's own.
    const policyOf = (route: RouteDefinition | undefined): ResolvedCORS | null => {
      const policy = route?.options[kCORSPolicy]
      return policy === undefined ? own : policy
    }

    // A route's own policy, `null` for one that turned CORS off; a route that set nothing keeps the plugin's. Kept on
    // the route: one `OPTIONS` route can catch the preflights of routes another scope's policy covers, and the hook
    // that sees them answers with theirs. Of two policies over one route, the first registered decides.
    context.server.hook('onRoute', route => {
      if (route.options[kCORSPolicy] !== undefined || route.options[kPreflightRoute] === true) {
        return
      }

      const where = `serve "${route.methods.join('|')} ${route.url}"`
      const value = route.options.cors

      if (value === undefined || value === true) {
        route.options[kCORSPolicy] = own
      } else if (value === false) {
        route.options[kCORSPolicy] = null
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        route.options[kCORSPolicy] = resolve(overlay(config, value), where)
      } else {
        throw refusal(
          where,
          'its CORS setting must be an object or a boolean',
          'Write "cors({ origins: [...] })" or "cors(false)"',
        )
      }
    })

    context.server.hook('onRequest', ctx => {
      if (!isPreflight(ctx)) {
        return
      }

      const origin = ctx.req.header('origin')!
      const requested = ctx.req.header('access-control-request-method')!
      // The policy's own `OPTIONS` routes are where preflights land, never what one asks for.
      const targets = (ctx as unknown as Context)
        [kRouteOf](requested)
        ?.filter(target => target.options[kPreflightRoute] !== true)
      const found = targets?.map(target => target.options[kCORSPolicy])
      // A route no policy covers is not one to grant.
      if (targets === undefined || found === undefined || targets.length === 0 || found.includes(undefined)) {
        return
      }

      const keys = new Set(found.map(policy => policy?.key ?? 'off'))
      if (keys.size > 1) {
        if (!warned.has(targets[0]!)) {
          warned.add(targets[0]!)
          context.logger.warn(
            { method: requested, path: targets[0]!.url },
            'Cannot answer a preflight: the routes behind it have different CORS settings',
          )
        }
        return
      }

      const policy = found[0]!
      if (policy === null || !allowed(policy, origin)) {
        return
      }

      allow(ctx, policy, origin)
      ctx.header('access-control-allow-methods', requested)

      const asked = ctx.req.header('access-control-request-headers')
      const reflecting = policy.allowHeaders === undefined && asked !== undefined
      const headers = reflecting ? asked : policy.allowHeaders
      if (headers !== undefined && headers !== '') {
        ctx.header('access-control-allow-headers', headers)
      }

      if (policy.maxAge !== undefined) {
        ctx.header('access-control-max-age', policy.maxAge)
      }

      const vary = [...(policy.any ? [] : ['Origin']), ...(reflecting ? ['Access-Control-Request-Headers'] : [])]
      if (vary.length > 0) {
        appendVary(ctx, vary)
      }

      ctx.status(204).body()
    })

    context.server.hook('onSend', ctx => {
      // A granted preflight has its headers; one not granted gets none.
      if (isPreflight(ctx)) {
        return
      }

      const policy = policyOf(ctx.route)
      if (policy === null) {
        return
      }

      if (!policy.any) {
        appendVary(ctx, ['Origin'])
      }

      // Under '*' the answer is the same whatever Origin says, so it varies on nothing.
      const origin = ctx.req.header('origin')
      if (!policy.any && (origin === undefined || !allowed(policy, origin))) {
        return
      }

      allow(ctx, policy, origin)
      if (policy.exposeHeaders !== undefined) {
        ctx.header('access-control-expose-headers', policy.exposeHeaders)
      }
    })
  }
}

function isPreflight(ctx: IContext): boolean {
  return (
    ctx.req.method === 'OPTIONS' &&
    ctx.req.header('origin') !== undefined &&
    ctx.req.header('access-control-request-method') !== undefined
  )
}

// The header is compared as a browser sends it: lower-case, with no default port, as the policy stores its origins.
function allowed(policy: ResolvedCORS, origin: string): boolean {
  return policy.any || policy.origins.has(origin)
}

function allow(ctx: IContext, policy: ResolvedCORS, origin: string | undefined): void {
  // `*` never goes with credentials: a policy that has both is refused.
  ctx.header('access-control-allow-origin', policy.any ? '*' : origin!)
  if (policy.credentials) {
    ctx.header('access-control-allow-credentials', 'true')
  }
}

/** `base` with every member of `over` that is not `undefined` written over it. */
function overlay(base: CORSConfig, over: object): CORSConfig {
  return { ...base, ...Object.fromEntries(Object.entries(over).filter(([, value]) => value !== undefined)) }
}

/**
 * Checks `config` and reads it into a policy.
 *
 * @throws ErrConfiguration naming `where`, as `build corsPolicy()` or `serve "GET /x"`, for settings no browser can be
 * answered from.
 */
function resolve(config: CORSConfig, where: string): ResolvedCORS {
  for (const key of Object.keys(config)) {
    if (!MEMBERS.has(key)) {
      throw refusal(
        where,
        `"${key}" is not a CORS setting`,
        'Use origins, credentials, allowedHeaders, exposedHeaders or maxAge',
      )
    }
  }

  for (const key of LISTS) {
    const list: unknown = config[key]
    if (list !== undefined && !(Array.isArray(list) && list.every(item => typeof item === 'string'))) {
      throw refusal(where, `"${key}" must be a list of strings`, `Write "${key}: ['...']"`)
    }
  }

  const listed = config.origins ?? []
  if (listed.length === 0) {
    throw refusal(
      where,
      'it names no origin',
      'List the origins a browser may call from, such as "https://app.example"',
      'Allow every origin with "*"',
    )
  }

  const any = listed.includes('*')
  if (any && listed.length > 1) {
    throw refusal(where, '"*" stands alone, with no other origin', 'Write "*" alone, or list the origins without it')
  }

  if (config.credentials !== undefined && typeof config.credentials !== 'boolean') {
    throw refusal(where, '"credentials" must be true or false', 'Write "credentials: true", or leave it out')
  }

  const credentials = config.credentials === true
  if (any && credentials) {
    throw refusal(
      where,
      'a browser refuses credentials for every origin ("*")',
      'List the origins instead of "*"',
      'Leave credentials off',
    )
  }

  const origins = new Set<string>()
  for (const text of any ? [] : listed) {
    const read = originProblem(text)
    if ('problem' in read) {
      throw refusal(where, `"${text}" is not an origin: ${read.problem}`, ...read.solutions)
    }
    origins.add(read.origin)
  }

  for (const name of [...(config.allowedHeaders ?? []), ...(config.exposedHeaders ?? [])]) {
    if (!HEADER_NAME.test(name)) {
      throw refusal(where, `"${name}" is not a header name`, 'Write a header name, such as "x-request-id"')
    }
  }

  const maxAge = config.maxAge
  if (maxAge !== undefined && !(typeof maxAge === 'number' && Number.isFinite(maxAge))) {
    throw refusal(where, '"maxAge" must be a duration', 'Write a duration, such as 10 * Minute')
  }

  if (maxAge !== undefined && maxAge < Second) {
    const shown = formatDuration(maxAge)
    throw refusal(
      where,
      `maxAge "${shown}" is under a second: a browser keeps a preflight's answer for whole seconds`,
      'Write at least 1 * Second',
    )
  }

  const allowHeaders = config.allowedHeaders?.join(', ')
  const exposeHeaders =
    config.exposedHeaders === undefined || config.exposedHeaders.length === 0
      ? undefined
      : config.exposedHeaders.join(', ')
  const seconds = maxAge === undefined ? undefined : String(Math.floor(maxAge / Second))
  const sortedOrigins = [...origins].sort((left, right) => {
    if (left === right) {
      return 0
    }
    return left < right ? -1 : 1
  })

  return {
    any,
    origins,
    credentials,
    allowHeaders,
    exposeHeaders,
    maxAge: seconds,
    key: JSON.stringify([
      any,
      sortedOrigins,
      credentials,
      allowHeaders ?? null,
      exposeHeaders ?? null,
      seconds ?? null,
    ]),
  }
}

function refusal(where: string, reason: string, ...solutions: string[]): ErrConfiguration {
  return configurationError(`Cannot ${where}: ${reason}`, ...solutions)
}

// A preflight the policy did not grant, or an `OPTIONS` request that is not one.
function notFound(ctx: IContext): never {
  throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
}
