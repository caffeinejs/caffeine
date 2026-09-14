import { Container } from '@caffeinejs/di'

import type { RouteGroup } from '../route.js'
import { createRouteGroupCompiler, type RouteGroupCompiler } from './compile.js'
import type { RouteBuildContext, RouteSource } from './source.js'

/** What {@link buildRouting} produces: the compiled groups, and the compiler that produced them. */
export interface BuiltRouting<R> {
  routeGroups: RouteGroup<R>[]
  /**
   * The same compiler every source built through — reused by `$route` (`http/adapter.ts`) to compile a group
   * accumulated after this pass, so a guard shared between an ordinary route and a `$route` one resolves
   * through the one cache, not a second one.
   */
  compileRouteGroup: RouteGroupCompiler
}

/**
 * Builds every router of the application, from every source.
 *
 * The shared state a route needs — the authorization configuration, the guard cache — is resolved once and
 * handed to all of them, so routes declared different ways still get one guard instance per key and the same
 * policies. Two sources claiming the same path is left to the server to reject at registration, which it does
 * with the path in the message.
 */
export function buildRouting<R>(sources: readonly RouteSource<R>[], container: Container): BuiltRouting<R> {
  const compileRouteGroup = createRouteGroupCompiler(container)
  const ctx: RouteBuildContext = { container, compileRouteGroup }

  if (sources.length === 1) {
    return { routeGroups: sources[0].build(ctx), compileRouteGroup }
  }

  const routeGroups: RouteGroup<R>[] = []
  for (const source of sources) {
    routeGroups.push(...source.build(ctx))
  }

  return { routeGroups, compileRouteGroup }
}
