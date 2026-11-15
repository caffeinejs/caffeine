import { kRouteConstraints, type ResolvedRouteConstraint } from '../core/constraints/keys.js'
import type { AnyRouteExtension } from '../core/routing/extension.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Route/group extension that selects on a registered route constraint. One implementation behind
 * {@link Constraint} — never a second copy.
 *
 * Writes into `route.config` under `kRouteConstraints` rather than a dedicated field, so group→route
 * inheritance is the existing generic `config` merge (`.extend(constraint(...))` on a route overrides the same
 * name set on its group). The server matches on it: on Fastify through the `constraints()` plugin, on the
 * web-standards engine by itself.
 */
export function constraint(name: string, value: unknown, options?: { header?: string }): AnyRouteExtension {
  return (target: { config(key: string, value: unknown): unknown }) => {
    target.config(
      kRouteConstraints,
      new Map<string, ResolvedRouteConstraint>([[name, { value, header: options?.header }]]),
    )
  }
}

/**
 * Selects the route — or every route of the group, on a class — when the request carries `value` for the
 * constraint `name`.
 *
 * On Fastify, `.with(constraints())` must be installed, and a name other than `version` and `host` needs its
 * strategy there. On the web-standards engine nothing is installed, and such a name needs its strategy in
 * `.server(...)`'s `constraints`. A route whose constraint the request does not satisfy is not matched, and the
 * request is answered 404. The programmatic form is {@link constraint}, applied with
 * `.extend(constraint(name, value), ...)`.
 */
export function Constraint(name: string, value: unknown, options?: { header?: string }) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, constraint(name, value, options))
    } else {
      configureRoute(context, constraint(name, value, options))
    }
  }
}
