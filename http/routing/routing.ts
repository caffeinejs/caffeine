import { Container } from '@caffeinejs/di'

import { createRouteGroupCompiler, type RouteGroupCompiler } from './compile.js'
import type { RouteGroup } from './route.js'

/**
 * Where routes come from.
 *
 * A source produces specs from wherever it collects them — the `@Controller` decorators, a programmatic
 * registration — and supplies the one thing a spec cannot express on its own: how each route is invoked.
 * Everything else is compiled generically, so two sources in the same application share one set of policies,
 * one guard cache, and one registration path.
 */
export interface RouteSource<R = unknown> {
  /** Identifies the source in diagnostics. */
  readonly name: string

  build(ctx: RouteBuildContext): RouteGroup<R>[]
}

export interface RouteBuildContext {
  container: Container

  /**
   * Compiles a spec into a registrable router: merges group-level declarations into each route, compiles the
   * authorization policy and the guard chain, and resolves the `@CatchWith` references.
   */
  compileRouteGroup: RouteGroupCompiler
}

/** What {@link buildRouting} produces: the compiled groups, and the compiler that produced them. */
export interface BuiltRouting<R> {
  routeGroups: RouteGroup<R>[]
  /**
   * The same compiler every source built through — reused by `$route` (`http/fastify_adapter.ts`) to compile a group
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
