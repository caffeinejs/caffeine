import type { FastifyInstance, FastifyRequest } from 'fastify'

import { ErrHTTPNotFound } from './error/http.js'
import { joinPaths } from './internal/paths/paths.js'
import type { RouteGroup } from './route.js'

/**
 * The static path prefixes the server owns, derived from the resolved routing.
 *
 * Derived rather than configured because a hand-written exclude list drifts the moment a controller is added
 * or renamed, and nothing reports it — the application keeps booting and starts answering an API miss with an
 * HTML document.
 *
 * A controller contributes its **base** path (`@Prefix` + `@Controller`), not its individual route URLs:
 * `@Controller('/api')` declaring only `@Get('/')` owns all of `/api`, so `/api/typo` stays a 404 instead of
 * falling through to a shell. A base that is empty or `/` would own the whole origin and leave a fallback
 * nothing to answer, so those controllers contribute their route paths instead.
 *
 * Paths are truncated at the first dynamic segment, since `/users/:id` tells us the server owns `/users`.
 */
export function deriveServerOwnedPaths(
  routeGroups: readonly RouteGroup<any>[],
  extraPaths: readonly string[] = [],
): string[] {
  const owned = new Set<string>()

  for (const router of routeGroups) {
    const base = staticPrefix(`${router.prefix ?? ''}${router.path}`)

    if (base !== '' && base !== '/') {
      owned.add(base)
      continue
    }

    // A controller mounted at the root owns no prefix of its own, so it speaks for its routes individually.
    for (const route of router.routes) {
      const path = staticPrefix(`${router.prefix ?? ''}${joinPaths(router.path, route.path)}`)

      if (path !== '' && path !== '/') {
        owned.add(path)
      }
    }
  }

  for (const path of extraPaths) {
    const extra = staticPrefix(path)

    if (extra !== '' && extra !== '/') {
      owned.add(extra)
    }
  }

  return [...owned].sort()
}

/**
 * Whether `path` falls under one of `owned`.
 *
 * Segment-aware on purpose: a plain `startsWith` would put `/apifoo` under `/api`.
 */
export function isServerOwned(owned: readonly string[], path: string): boolean {
  return owned.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

/**
 * Installs the root not-found handler, which turns an unmatched URL into {@link ErrHTTPNotFound}.
 *
 * Throwing rather than replying is what puts an unmatched URL through the application's error handling, so a
 * global `@Catch(ErrHTTPNotFound)` sees it and the body matches a 404 a handler threw.
 *
 * Fastify allows one not-found handler per encapsulation context. A handler already set on the server — by a
 * plugin, or on a Fastify instance the caller brought — stands, and nothing is installed. Such a handler throws
 * {@link ErrHTTPNotFound} for the requests it does not answer, or those requests bypass `@Catch`.
 */
export function installNotFoundHandler(server: FastifyInstance): void {
  try {
    server.setNotFoundHandler(async (req: FastifyRequest): Promise<never> => {
      throw new ErrHTTPNotFound(`Route ${req.method}:${req.url} not found`)
    })
  } catch (error) {
    if (!isAlreadySetError(error)) {
      throw error
    }
  }
}

/** Fastify's duplicate-handler guard throws a bare `Error`, identifiable only by its message. */
function isAlreadySetError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Not found handler already set')
}

/** The leading static portion of a route path — everything before the first `:param` or `*` segment. */
function staticPrefix(path: string): string {
  // A controller mounted at '/' joins to '//health', since joinPaths only concatenates.
  const segments = path.replace(/\/{2,}/g, '/').split('/')
  const stable: string[] = []

  for (const segment of segments) {
    if (segment.startsWith(':') || segment.startsWith('*')) {
      break
    }

    stable.push(segment)
  }

  const joined = stable.join('/')

  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}
