import type { Container } from '@caffeinejs/di'
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RouteGenericInterface,
  RouteOptions,
} from 'fastify'
import type { Route, Router } from './route.js'
import type { Services } from './service.js'

/**
 * The mutable route definition a configurer may adjust before it is registered.
 */
export type ConfigurableRouteDef = RouteOptions<
  RawServerBase,
  RawRequestDefaultExpression<RawServerBase>,
  RawReplyDefaultExpression<RawServerBase>,
  RouteGenericInterface,
  any
>

/**
 * Once, on the root server, before any controller is registered.
 */
export interface ServerPhaseContext {
  server: FastifyInstance
  container: Container
  services: Services
  routers: Router<any>[]
}

/**
 * Inside a controller's encapsulated `register()`.
 */
export interface RouterPhaseContext {
  server: FastifyInstance
  container: Container
  services: Services
  router: Router<any>
}

/**
 * Per route, before it is registered. Mutate `routeDef` to add hooks, schema, config, etc.
 */
export interface RoutePhaseContext {
  server: FastifyInstance
  container: Container
  services: Services
  router: Router<any>
  route: Route<any>
  routeDef: ConfigurableRouteDef
}

/**
 * A feature's Fastify wiring, split into optional phase hooks the adapter runs in a dependency-ordered
 * sequence. Replaces the old single-purpose `RouteConfigurer`.
 *
 * Abstract class so it doubles as the DI token and the base type: bind an implementation with
 * `container.bind(MyConfigurer).toClass(MyConfigurer).extends()` and the adapter discovers it via
 * `getManyOptional(FeatureConfigurer)`. Order relative to other features with {@link before}/{@link after}
 * (by `name`); the built-in features are named `authentication`, `authorization`, `oidc`, `form-body`,
 * `cache`, `cache-invalidate`.
 */
export abstract class FeatureConfigurer {
  abstract readonly name: string

  readonly before?: readonly string[]
  readonly after?: readonly string[]

  configureServer?(ctx: ServerPhaseContext): void | Promise<void>
  configureRouter?(ctx: RouterPhaseContext): void | Promise<void>
  configureRoute?(ctx: RoutePhaseContext): void | Promise<void>
}

/**
 * Topologically orders configurers by their `before`/`after` names (Kahn's algorithm). Ties keep the
 * input order (stable). Unknown referenced names are ignored (an optional dependency may be absent).
 *
 * @throws Error when the dependencies form a cycle.
 */
export function orderConfigurers(configurers: readonly FeatureConfigurer[]): FeatureConfigurer[] {
  const byName = new Map<string, FeatureConfigurer>()
  for (const c of configurers) {
    byName.set(c.name, c)
  }

  // edges: dependency -> dependents. indegree counts unmet dependencies per node.
  const dependents = new Map<FeatureConfigurer, FeatureConfigurer[]>()
  const indegree = new Map<FeatureConfigurer, number>()
  for (const c of configurers) {
    dependents.set(c, [])
    indegree.set(c, 0)
  }

  const addEdge = (from: FeatureConfigurer, to: FeatureConfigurer): void => {
    // from must run before to
    dependents.get(from)!.push(to)
    indegree.set(to, indegree.get(to)! + 1)
  }

  for (const c of configurers) {
    for (const afterName of c.after ?? []) {
      const dep = byName.get(afterName)
      if (dep) {
        addEdge(dep, c)
      }
    }
    for (const beforeName of c.before ?? []) {
      const dep = byName.get(beforeName)
      if (dep) {
        addEdge(c, dep)
      }
    }
  }

  // Seed the queue in input order so ties stay stable.
  const queue = configurers.filter(c => indegree.get(c) === 0)
  const ordered: FeatureConfigurer[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    ordered.push(node)
    for (const dependent of dependents.get(node)!) {
      const next = indegree.get(dependent)! - 1
      indegree.set(dependent, next)
      if (next === 0) {
        queue.push(dependent)
      }
    }
  }

  if (ordered.length !== configurers.length) {
    const cyclic = configurers.filter(c => !ordered.includes(c)).map(c => c.name)
    throw new Error(`Cannot order feature configurers: dependency cycle among [${cyclic.join(', ')}]`)
  }

  return ordered
}
