import { formatDuration, type Duration } from '@caffeinejs/std/duration'

import { findMyWayMatcher } from '../matcher/find_my_way.js'
import { DEFAULT_ROUTER_FLAGS, type RouteMatcherFactory, type RouterFlags } from '../matcher/matcher.js'
import { configurationError, USE_FASTIFY } from './error.js'

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
}

/** {@link ServerSettings} with every default filled in. */
export interface ResolvedServerSettings {
  readonly handlerTimeout: Duration | undefined
  readonly router: RouterFlags
  readonly matcher: RouteMatcherFactory
}

/** The longest a timer waits: a timer set for longer fires at once. */
export const MAX_TIMEOUT: Duration = 2_147_483_647

/** Whether `value` is a duration a timer can wait out: above 0, and at most {@link MAX_TIMEOUT}. */
export function isTimeout(value: unknown): value is Duration {
  return typeof value === 'number' && value > 0 && value <= MAX_TIMEOUT
}

const SETTINGS = new Set(['handlerTimeout', 'router', 'matcher'])
const FASTIFY_SECTIONS = new Set(['factory', 'listener'])

/**
 * What `.server(...)` resolved to, checked and with its defaults.
 *
 * @throws ErrConfiguration for a section that is not a setting, a `handlerTimeout` not above 0, a `router` that is
 *   not an object of boolean router flags, or a `matcher` that is not a function.
 */
export function resolveServerSettings(settings: object): ResolvedServerSettings {
  for (const key of Object.keys(settings)) {
    if (!SETTINGS.has(key)) {
      throw configurationError(
        `Cannot build the server: "${key}" is not a setting of the fetch application`,
        ...(FASTIFY_SECTIONS.has(key) ? [`${USE_FASTIFY} to pass Fastify settings`] : []),
        'Return only handlerTimeout, router and matcher from ".server(...)"',
      )
    }
  }

  const { handlerTimeout, router, matcher } = settings as ServerSettings

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

  return { handlerTimeout, router: routerFlags(router), matcher: matcher ?? findMyWayMatcher }
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
