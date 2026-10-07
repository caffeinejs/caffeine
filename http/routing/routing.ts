import { Container } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/framework'

import { ErrConfiguration } from '../error/common.js'
import { createRouteGroupCompiler, type RouteGroupCompiler, type RouteGroupMeta } from './compile.js'
import type { RouteGroup } from './route.js'
import type { RouteGroupSpec } from './spec.js'

/**
 * Where routes come from.
 *
 * A source declares groups from wherever it collects them — the `@Controller` decorators, a programmatic
 * registration — and supplies the one thing a spec cannot express on its own: how each route is invoked. It neither
 * compiles nor filters: which server serves a group is read from the group's labels by whoever selects it, and
 * everything selected is compiled generically, so two sources in the same application share one set of policies,
 * one guard cache, and one registration path.
 */
export interface RouteSource<R = unknown> {
  /** Identifies the source in diagnostics. */
  readonly name: string

  /** Every group this source declares, uncompiled. */
  collect(container: Container): DeclaredRouteGroup<R>[]
}

/** A group as its source declared it, before a server selected it. */
export interface DeclaredRouteGroup<R> {
  /** What the group goes by in diagnostics: the controller's class name, or the router's. */
  readonly name: string

  /** What was declared, labels included. */
  readonly spec: RouteGroupSpec<R>

  /** What the source adds to the compiled group. Called once a server selects the group, and never before. */
  meta(): RouteGroupMeta<R>

  /** What installs its plugins in front of the group's routes: the routers or the controller class, outermost first. */
  readonly scopes?: readonly object[]
}

/** The labels a group carries, keyed by whoever reads them. Empty when nothing labelled the group. */
export type RouteGroupLabels = ReadonlyMap<symbol, unknown>

/** What {@link buildRouting} produces: every declared group, compiled only once a server selects it. */
export interface Routing<R> {
  /**
   * Compiles every declared group whose labels `accept` takes, in the order the sources declared them.
   *
   * @throws ErrConfiguration when `accept` takes a group an earlier call already selected: two servers would serve it.
   */
  select(accept: (labels: RouteGroupLabels) => boolean): RouteGroup<R>[]

  /** The declared groups no {@link select} call has taken yet. */
  unselected(): readonly DeclaredRouteGroup<R>[]

  /**
   * The compiler every selected group goes through — reused by `$route` (`http/fastify_adapter.ts`) to compile a
   * group accumulated afterwards, so a guard shared between an ordinary route and a `$route` one resolves through
   * the one cache, not a second one.
   */
  readonly compileRouteGroup: RouteGroupCompiler
}

const kNoLabels: RouteGroupLabels = new Map()

/**
 * Collects every router of the application, from every source, for the servers to select from.
 *
 * The shared state a route needs — the authorization configuration, the guard cache — is resolved once and
 * handed to every selection, so routes declared different ways and served by different servers still get one
 * guard instance per key and the same policies. Two sources claiming the same path on one server is left to the
 * server to reject at registration, which it does with the path in the message.
 */
export function buildRouting<R>(sources: readonly RouteSource<R>[], container: Container): Routing<R> {
  const compileRouteGroup = createRouteGroupCompiler(container)
  const declared = sources.flatMap(source => source.collect(container))
  const taken = new Set<DeclaredRouteGroup<R>>()

  return {
    compileRouteGroup,

    select(accept) {
      const groups: RouteGroup<R>[] = []

      for (const group of declared) {
        if (!accept(group.spec.labels ?? kNoLabels)) {
          continue
        }

        if (taken.has(group)) {
          throw new ErrConfiguration(
            errMessage(`Cannot select route group "${group.name}": another server already serves it`)
              .solutions('Select each group for one server only: the labels it carries decide which')
              .reference('@caffeinejs/http', ErrConfiguration)
              .build(),
          )
        }

        taken.add(group)

        const compiled = compileRouteGroup(group.spec, group.meta())
        if (group.scopes !== undefined) {
          compiled.scopes = group.scopes
        }

        groups.push(compiled)
      }

      return groups
    },

    unselected() {
      return declared.filter(group => !taken.has(group))
    },
  }
}
