import { Container } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/framework/err'

import { ErrConfiguration } from '../error/common.js'
import { createRouteGroupCompiler, type RouteGroupMeta } from './compile.js'
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

/** What {@link buildRouting} produces: the groups declared so far, each compiled only once a server selects it. */
export interface Routing<R> {
  /**
   * Declares the groups `sources` collect now, after every group declared before, and returns this call's groups in
   * declaration order. Nothing compiles until a server selects them.
   */
  declare(...sources: RouteSource<R>[]): readonly DeclaredRouteGroup<R>[]

  /**
   * Compiles every declared group whose labels `accept` takes, in the order they were declared.
   *
   * @throws ErrConfiguration when `accept` takes a group an earlier call already selected: two servers would serve it.
   */
  select(accept: (labels: RouteGroupLabels) => boolean): RouteGroup<R>[]
}

const kNoLabels: RouteGroupLabels = new Map()

/**
 * The routing of an application, with nothing declared yet: its sources are declared as their routers become known,
 * and each server selects the groups bound to it.
 *
 * The shared state a route needs — the authorization configuration, the guard cache — is resolved once and
 * handed to every selection, so routes declared different ways and served by different servers still get one
 * guard instance per key and the same policies. Two sources claiming the same path on one server is left to the
 * server to reject at registration, which it does with the path in the message.
 */
export function buildRouting<R>(container: Container): Routing<R> {
  const compileRouteGroup = createRouteGroupCompiler(container)
  const declared: DeclaredRouteGroup<R>[] = []
  const taken = new Set<DeclaredRouteGroup<R>>()

  return {
    declare(...sources) {
      const added = sources.flatMap(source => source.collect(container))
      declared.push(...added)
      return added
    },

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
  }
}
