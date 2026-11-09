import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance } from 'fastify'

import { ErrConfiguration } from '../../core/error/common.js'
import type { RegisteredRoute } from './security/security.js'

/** How a server's router matches a request's path. */
export interface RouterFlags {
  readonly caseSensitive: boolean
  readonly ignoreTrailingSlash: boolean
  readonly ignoreDuplicateSlashes: boolean
  /** Whether `;` starts the query, as `?` does. */
  readonly useSemicolonDelimiter: boolean
}

const kRouterFlags = Symbol('@caffeinejs/http:router-flags')

// find-my-way's own defaults, which Fastify keeps.
const DEFAULTS: RouterFlags = {
  caseSensitive: true,
  ignoreTrailingSlash: false,
  ignoreDuplicateSlashes: false,
  useSemicolonDelimiter: false,
}

/**
 * How the router of `server` matches a request's path, as Fastify resolved its options.
 *
 * Not `initialConfig`: a `routerOptions` object there gives each flag it leaves out its default, over the top-level
 * flag of the same name, which Fastify's router still reads.
 *
 * @throws ErrConfiguration on a server the adapter did not build.
 */
export function routerFlagsOf(server: FastifyInstance): RouterFlags {
  const flags = (server as unknown as Record<symbol, RouterFlags | undefined>)[kRouterFlags]

  if (flags === undefined) {
    throw notBuilt('read the router flags')
  }

  return flags
}

/**
 * Records on `server` the flags its router was built with from `options`, as Fastify reads them: a key `routerOptions`
 * holds first, then the top-level one, then the default.
 */
export function recordRouterFlags(server: FastifyInstance, options: object): void {
  const top = options as Partial<Record<keyof RouterFlags, boolean>> & { routerOptions?: object | null }
  const nested = (top.routerOptions ?? {}) as Partial<Record<keyof RouterFlags, boolean>>
  const flag = (name: keyof RouterFlags): boolean =>
    (Object.hasOwn(nested, name) ? nested[name] : top[name]) ?? DEFAULTS[name]

  server.decorate(kRouterFlags, {
    caseSensitive: flag('caseSensitive'),
    ignoreTrailingSlash: flag('ignoreTrailingSlash'),
    ignoreDuplicateSlashes: flag('ignoreDuplicateSlashes'),
    useSemicolonDelimiter: flag('useSemicolonDelimiter'),
  } satisfies RouterFlags)
}

const kRouteLookup = Symbol('@caffeinejs/http:route-lookup')

type RouteLookup = (method: string, path: string) => boolean

/**
 * Whether a route registered on `server` so far answers `method` at `path`, whatever its constraints. Paths compare
 * as the router matches them, case and slashes folded by {@link routerFlagsOf}; a parameter or a wildcard compares as
 * written.
 *
 * Fastify's `hasRoute` finds a route only by the constraints it registered with, so it misses one constrained to a
 * version or a host. This is for a plugin that must refuse a route registered before it: one registered after it
 * reaches the plugin's own `onRoute` hook.
 *
 * @throws ErrConfiguration on a server the adapter did not build, or once the server is ready.
 */
export function hasRouteAt(server: FastifyInstance, method: string, path: string): boolean {
  const lookup = (server as unknown as Record<symbol, RouteLookup | undefined>)[kRouteLookup]

  if (lookup === undefined) {
    throw notBuilt(`look up a route at "${path}"`)
  }

  return lookup(method, path)
}

/**
 * Answers {@link hasRouteAt} on `server` from `routes`, which the adapter's root `onRoute` hook fills, until `closed`
 * says the server is ready and the record is gone.
 */
export function installRouteLookup(
  server: FastifyInstance,
  routes: readonly RegisteredRoute[],
  closed: () => boolean,
): void {
  // Indexed as routes arrive: a mount asks once per file, and a site has thousands.
  const index = new Set<string>()
  let indexed = 0

  server.decorate(kRouteLookup, ((method, path) => {
    if (closed()) {
      throw new ErrConfiguration(
        errMessage(`Cannot look up a route at "${path}": the server is ready, and its routes are no longer recorded`)
          .solutions('Look the route up while the plugin registers, before the server is ready')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    const flags = routerFlagsOf(server)

    for (; indexed < routes.length; indexed++) {
      const { method: methods, url } = routes[indexed]!

      for (const each of typeof methods === 'string' ? [methods] : methods) {
        index.add(`${each.toUpperCase()} ${fold(url, flags)}`)
      }
    }

    return index.has(`${method.toUpperCase()} ${fold(path, flags)}`)
  }) satisfies RouteLookup)
}

/** `path` as the router registers it: slashes folded as its flags say, and lower-cased when it ignores case. */
function fold(path: string, flags: RouterFlags): string {
  const collapsed = flags.ignoreDuplicateSlashes ? path.replace(/\/{2,}/g, '/') : path
  const trimmed = flags.ignoreTrailingSlash && collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed

  return flags.caseSensitive ? trimmed : trimmed.toLowerCase()
}

function notBuilt(action: string): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(`Cannot ${action}: the server was not built by the Caffeine adapter`)
      .solutions('Call it from a plugin registered with ".with(...)" on the application')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}
