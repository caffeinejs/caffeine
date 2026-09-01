import type { Container } from '@caffeinejs/di'
import type { RouteGroup } from '../route.js'
import type { RouteGroupCompiler } from './compile.js'

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
