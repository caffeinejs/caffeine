import { Container } from '@caffeinejs/di'

import type { RouteGroup } from '../route.js'
import { createRouteGroupCompiler } from './compile.js'
import type { RouteBuildContext, RouteSource } from './source.js'

/**
 * Builds every router of the application, from every source.
 *
 * The shared state a route needs — the authorization configuration, the guard cache — is resolved once and
 * handed to all of them, so routes declared different ways still get one guard instance per key and the same
 * policies. Two sources claiming the same path is left to the server to reject at registration, which it does
 * with the path in the message.
 */
export function buildRouting<R>(sources: readonly RouteSource<R>[], container: Container): RouteGroup<R>[] {
  const ctx: RouteBuildContext = {
    container,
    compileRouteGroup: createRouteGroupCompiler(container),
  }

  if (sources.length === 1) {
    return sources[0].build(ctx)
  }

  const routeGroups: RouteGroup<R>[] = []
  for (const source of sources) {
    routeGroups.push(...source.build(ctx))
  }

  return routeGroups
}
