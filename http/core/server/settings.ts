import type { ByteSize } from '@caffeinejs/std/bytes'
import { formatDuration, type Duration } from '@caffeinejs/std/duration'

import type { ConstraintStrategy } from '../constraints/constraints.js'
import { findMyWayMatcher } from '../matcher/find_my_way.js'
import { DEFAULT_ROUTER_FLAGS, type RouteMatcherFactory, type RouterFlags } from '../matcher/matcher.js'
import { typeBoxSchemaCompiler } from '../validation/typebox.js'
import type { SchemaCompiler } from '../validation/validation.js'
import { DEFAULT_BODY_LIMIT, isBodyLimit } from './body.js'
import { configurationError, USE_NODE } from './error.js'
import { compileTrustProxy, type TrustProxy } from './trust.js'

/** What `.server(...)` returns on the fetch application. */
export interface ServerSettings {
  /**
   * How long a route's handler may run before the request is answered 503. Unset: no limit. A route's `@Timeout`
   * wins.
   */
  handlerTimeout?: Duration
  /** How the router matches a path. Unset flags keep find-my-way's defaults. */
  router?: Partial<RouterFlags>
  /** The matcher routes are registered in. Defaults to {@link findMyWayMatcher}. */
  matcher?: RouteMatcherFactory
  /**
   * Constraint strategies routes may name besides `version` and `host`, such as one resolved out of the container.
   * One named `version` or `host` replaces the built-in.
   */
  constraints?: readonly ConstraintStrategy<unknown>[]
  /**
   * Whether `X-Forwarded-Host` and `X-Forwarded-Proto` decide `ctx.req.host` and `ctx.req.protocol`: `true` trusts
   * any peer, and the last entry of each header wins. Unset: no peer. The fetch runtime gives no peer address, so
   * proxies named by address are the Node application's.
   */
  trustProxy?: boolean
  /** The request header `ctx.req.id` is taken from when a request carries it. Unset: requests are numbered. */
  requestIDHeader?: string
  /**
   * The largest request body a route reads, in bytes, such as `10 * MiB`; a route's own `bodyLimit` wins. A larger
   * body answers 413. Unset: `1 * MiB`.
   */
  bodyLimit?: ByteSize
  /**
   * Turns a route's TypeBox schemas into validators and serializers. Unset: {@link typeBoxSchemaCompiler}. A Standard
   * Schema slot validates itself whatever this is.
   */
  schemaCompiler?: SchemaCompiler
}

/** {@link ServerSettings} with every default filled in. */
export interface ResolvedServerSettings {
  readonly handlerTimeout: Duration | undefined
  readonly router: RouterFlags
  readonly matcher: RouteMatcherFactory
  readonly constraints: readonly ConstraintStrategy<unknown>[]
  readonly trustProxy: TrustProxy | undefined
  /** Lower-cased. */
  readonly requestIDHeader: string | undefined
  /** The application's name in messages: `fetch application`, `Node application`. */
  readonly application: string
  readonly bodyLimit: ByteSize
  readonly schemaCompiler: SchemaCompiler
}

/** One kind of application: its name, the settings sections only it takes, and whether its runtime knows the peer. */
export interface ApplicationKind {
  readonly name: string
  readonly sections: ReadonlySet<string>
  readonly peerAddress: boolean
}

const FETCH_APPLICATION: ApplicationKind = { name: 'fetch application', sections: new Set(), peerAddress: false }

/** The longest a timer waits: a timer set for longer fires at once. */
export const MAX_TIMEOUT: Duration = 2_147_483_647

/** Whether `value` is a duration a timer can wait out: above 0, and at most {@link MAX_TIMEOUT}. */
export function isTimeout(value: unknown): value is Duration {
  return typeof value === 'number' && value > 0 && value <= MAX_TIMEOUT
}

const SETTINGS = [
  'handlerTimeout',
  'router',
  'matcher',
  'constraints',
  'trustProxy',
  'requestIDHeader',
  'bodyLimit',
  'schemaCompiler',
]
/** The settings sections only the Node application takes: what Node itself configures. */
export const NODE_SECTIONS: ReadonlySet<string> = new Set(['listen', 'http', 'https', 'http2'])

/** A header name, as RFC 9110 writes a token. */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * What `.server(...)` resolved to, checked and with its defaults. The sections only `application` takes are left to
 * its caller.
 *
 * @throws ErrConfiguration for a section that is not a setting, a `handlerTimeout` not above 0, a `router` that is
 *   not an object of boolean router flags, a `matcher` that is not a function, a `constraints` setting that is not an
 *   array of strategies or names one twice, a `trustProxy` the application cannot apply, or a `requestIDHeader` that
 *   is not a header name.
 */
export function resolveServerSettings(
  settings: object,
  application: ApplicationKind = FETCH_APPLICATION,
): ResolvedServerSettings {
  for (const key of Object.keys(settings)) {
    if (!SETTINGS.includes(key) && !application.sections.has(key)) {
      throw configurationError(
        `Cannot build the server: "${key}" is not a setting of the ${application.name}`,
        ...(NODE_SECTIONS.has(key) ? [`${USE_NODE} to serve on a Node server`] : []),
        `Return only ${[...SETTINGS, ...application.sections].join(', ')} from ".server(...)"`,
      )
    }
  }

  // `trustProxy` and `requestIDHeader` are read as given: a Node application's `trustProxy` is wider.
  const { handlerTimeout, router, matcher, constraints, trustProxy, requestIDHeader, bodyLimit, schemaCompiler } =
    settings as Omit<
      ServerSettings,
      'constraints' | 'trustProxy' | 'requestIDHeader' | 'bodyLimit' | 'schemaCompiler'
    > & {
      constraints?: unknown
      trustProxy?: unknown
      requestIDHeader?: unknown
      bodyLimit?: unknown
      schemaCompiler?: unknown
    }

  if (handlerTimeout !== undefined && !isTimeout(handlerTimeout)) {
    throw configurationError(
      `Cannot set handlerTimeout to "${String(handlerTimeout)}": it must be a duration above 0 and at most ${formatDuration(MAX_TIMEOUT)}`,
      'Write a positive duration, such as 30 * Second',
      'Leave handlerTimeout out for no limit',
    )
  }

  if (matcher !== undefined && typeof matcher !== 'function') {
    throw configurationError(
      `Cannot use the matcher setting: it must be a function, got ${typeof matcher}`,
      'Pass a RouteMatcherFactory, such as findMyWayMatcher, or leave matcher out',
    )
  }

  if (constraints !== undefined && !(Array.isArray(constraints) && constraints.every(isConstraintStrategy))) {
    throw configurationError(
      'Cannot use the constraints setting: it must be an array of constraint strategies',
      'Pass ConstraintStrategy objects, such as one resolved with container.get(...)',
      'Leave constraints out',
    )
  }

  const strategies = (constraints ?? []) as readonly ConstraintStrategy<unknown>[]
  const named = new Set<string>()
  for (const strategy of strategies) {
    if (named.has(strategy.name)) {
      throw configurationError(
        `Cannot use the constraints setting: two strategies are named "${strategy.name}"`,
        'Keep one strategy per name',
      )
    }
    named.add(strategy.name)
  }

  if (requestIDHeader !== undefined && (typeof requestIDHeader !== 'string' || !HEADER_NAME.test(requestIDHeader))) {
    throw configurationError(
      `Cannot set requestIDHeader to "${String(requestIDHeader)}": it is not a header name`,
      'Write a header name, such as "x-request-id"',
      'Leave requestIDHeader out to number requests',
    )
  }

  if (bodyLimit !== undefined && !isBodyLimit(bodyLimit)) {
    throw configurationError(
      `Cannot set bodyLimit to "${String(bodyLimit)}": it must be a whole number of bytes above 0`,
      'Write a size in bytes, such as 1 * MiB',
      'Leave bodyLimit out for the default, 1 * MiB',
    )
  }

  if (schemaCompiler !== undefined && !isSchemaCompiler(schemaCompiler)) {
    throw configurationError(
      'Cannot use the schemaCompiler setting: it must have validator and serializer functions',
      'Pass a SchemaCompiler, such as typeBoxSchemaCompiler, or leave schemaCompiler out',
    )
  }

  return {
    handlerTimeout,
    router: routerFlags(router),
    matcher: matcher ?? findMyWayMatcher,
    constraints: strategies,
    trustProxy: compileTrustProxy(trustProxy, application),
    requestIDHeader: typeof requestIDHeader === 'string' ? requestIDHeader.toLowerCase() : undefined,
    application: application.name,
    bodyLimit: bodyLimit ?? DEFAULT_BODY_LIMIT,
    schemaCompiler: schemaCompiler ?? typeBoxSchemaCompiler,
  }
}

function isConstraintStrategy(value: unknown): value is ConstraintStrategy<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { name, storage, deriveConstraint } = value as Partial<Record<keyof ConstraintStrategy, unknown>>
  return (
    typeof name === 'string' && name !== '' && typeof storage === 'function' && typeof deriveConstraint === 'function'
  )
}

function isSchemaCompiler(value: unknown): value is SchemaCompiler {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { validator, serializer } = value as Partial<Record<keyof SchemaCompiler, unknown>>
  return typeof validator === 'function' && typeof serializer === 'function'
}

function routerFlags(router: unknown): RouterFlags {
  if (router === undefined) {
    return DEFAULT_ROUTER_FLAGS
  }

  if (typeof router !== 'object' || router === null || Array.isArray(router)) {
    throw configurationError(
      `Cannot set router to "${String(router)}": it must be an object of router flags`,
      'Return router as an object, such as { caseSensitive: false }',
    )
  }

  // A flag written as `undefined` keeps its default rather than unsetting it.
  const given: Record<string, boolean> = {}

  for (const [key, value] of Object.entries(router)) {
    if (!Object.hasOwn(DEFAULT_ROUTER_FLAGS, key)) {
      throw configurationError(
        `Cannot set router "${key}": it is not a router flag`,
        'Use caseSensitive, ignoreTrailingSlash, ignoreDuplicateSlashes or useSemicolonDelimiter',
      )
    }

    if (value !== undefined && typeof value !== 'boolean') {
      throw configurationError(
        `Cannot set router.${key} to "${String(value)}": a router flag is true or false`,
        `Write router.${key} as true or false`,
      )
    }

    if (value !== undefined) {
      given[key] = value
    }
  }

  return { ...DEFAULT_ROUTER_FLAGS, ...given }
}
