import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance, RouteOptions } from 'fastify'

import { ErrConfiguration } from '../../core/error/common.js'
import { DEFAULT_ROUTER_FLAGS, type RouterFlags } from '../../core/matcher/matcher.js'

const kRouterFlags = Symbol('@caffeinejs/http:router-flags')

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
    (Object.hasOwn(nested, name) ? nested[name] : top[name]) ?? DEFAULT_ROUTER_FLAGS[name]

  server.decorate(kRouterFlags, {
    caseSensitive: flag('caseSensitive'),
    ignoreTrailingSlash: flag('ignoreTrailingSlash'),
    ignoreDuplicateSlashes: flag('ignoreDuplicateSlashes'),
    useSemicolonDelimiter: flag('useSemicolonDelimiter'),
  } satisfies RouterFlags)
}

/**
 * Remembers the first URL of a prefixed root whose options Fastify reuses for its slash alias.
 *
 * Fastify adds the second alias after registering the first, without another onRoute call. Read the value
 * replaced by that assignment, which already includes any changes from the application's onRoute hooks.
 */
export function trackPrefixedRootURL(
  route: RouteOptions & { routePath: string; prefix: string },
): (() => string | undefined) | undefined {
  if (route.prefix === '' || route.routePath !== '') {
    return undefined
  }

  const alias = `${route.prefix}/`
  let current = route.url
  let first: string | undefined
  const getURL = () => current

  Object.defineProperty(route, 'url', {
    configurable: true,
    enumerable: true,
    get: getURL,
    set(url: string) {
      if (url === alias) {
        first = current
      }

      current = url
    },
  })

  return () => {
    // A hook that redefined the property took the assignments that name the first URL with it: what registered there
    // can no longer be read, so it is refused rather than passed unchecked.
    if (Object.getOwnPropertyDescriptor(route, 'url')?.get !== getURL) {
      throw new ErrConfiguration(
        errMessage(`Cannot check the routes under "${route.prefix}": an onRoute hook redefined the "url" property`)
          .solutions('Assign route.url in the onRoute hook instead of calling Object.defineProperty on it')
          .reference('@caffeinejs/http', ErrConfiguration)
          .build(),
      )
    }

    Object.defineProperty(route, 'url', { configurable: true, enumerable: true, writable: true, value: current })

    return route.routePath === '/' ? first : undefined
  }
}

function notBuilt(action: string): ErrConfiguration {
  return new ErrConfiguration(
    errMessage(`Cannot ${action}: the server was not built by the Caffeine adapter`)
      .solutions('Call it from a plugin registered with ".with(...)" on the application')
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}
