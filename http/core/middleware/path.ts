import { joinRoutePath, literalPrefix, normalizeRoutePath, parseRoutePattern, underPrefix } from '../routing/paths.js'
import { configurationError } from '../server/error.js'
import type { MiddlewarePath } from './middleware.js'
import type { ResolvedMiddleware } from './pipeline.js'

// Path matching for middleware registered under a path, against `ctx.req.path`.

/**
 * What a middleware's path matches: each of its literal prefixes, on whole segments and case-sensitively, as the router
 * matches a route.
 */
export function prefixMatcher(path: MiddlewarePath): (path: string) => boolean {
  const prefixes = pathsOf(path).map(literalPrefix)
  return request => prefixes.some(prefix => underPrefix(request, prefix))
}

/**
 * A router's or a controller's middleware with each path joined to `base`, that scope's path: `/jobs` added by a
 * router at `/admin` covers `/admin/jobs`. A middleware with no path covers every route of the scope already.
 *
 * @throws ErrConfiguration when a middleware has a path and `base` holds a parameter: a middleware path is
 *   compared with `ctx.req.path` as text.
 */
export function placeMiddlewares(base: string, middlewares: readonly ResolvedMiddleware[]): ResolvedMiddleware[] {
  const placed = middlewares.find(middleware => middleware.path !== undefined)
  if (placed === undefined) {
    return [...middlewares]
  }

  const parts = parseRoutePattern(base)
  if (parts.some(part => part.kind !== 'text')) {
    throw configurationError(
      `Cannot add a middleware under "${String(placed.path)}" to the routes at "${base}": that path holds a parameter, and a middleware path is compared with the request path as text`,
      'Add the middleware without a path on a router or controller of its own at that sub-path, which it then covers whole',
    )
  }

  // `::` reads as `:`, as the request path holds it.
  const text = parts.map(part => (part.kind === 'text' ? part.text : '')).join('')
  return middlewares.map(middleware =>
    middleware.path === undefined
      ? middleware
      : { ...middleware, path: pathsOf(middleware.path).map(path => joinRoutePath(text, normalizeRoutePath(path))) },
  )
}

function pathsOf(path: MiddlewarePath): readonly string[] {
  return typeof path === 'string' ? [path] : path
}
