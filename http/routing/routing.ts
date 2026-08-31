import { Container } from '@caffeinejs/di'
import type { Router } from '../route.js'
import { createRouterCompiler } from './compile.js'
import type { RouteBuildContext, RouteSource } from './source.js'

/**
 * Builds every router of the application, from every source.
 *
 * The shared state a route needs — the authorization configuration, the guard cache — is resolved once and
 * handed to all of them, so routes declared different ways still get one guard instance per key and the same
 * policies. Two sources claiming the same path is left to the server to reject at registration, which it does
 * with the path in the message.
 */
export function buildRouting<R>(sources: readonly RouteSource<R>[], container: Container): Router<R>[] {
  const ctx: RouteBuildContext = {
    container,
    compileRouter: createRouterCompiler(container),
  }

  if (sources.length === 1) {
    return sources[0].build(ctx)
  }

  const routers: Router<R>[] = []
  for (const source of sources) {
    routers.push(...source.build(ctx))
  }

  return routers
}
