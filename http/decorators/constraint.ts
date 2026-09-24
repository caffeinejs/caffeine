import { kRouteConstraints, type ResolvedRouteConstraint } from '../constraints/constraints.js'
import type { AnyRouteExtension } from '../routing/extension.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Route/group extension that selects on a registered route constraint. One implementation behind
 * {@link Constraint} — never a second copy.
 *
 * Writes into `route.config` under `kRouteConstraints` rather than a dedicated field, so group→route
 * inheritance is the existing generic `config` merge (`.with(constraint(...))` on a route overrides the same
 * name set on its group). The `constraints()` plugin resolves it into Fastify's actual `constraints` matching
 * object, and a custom name needs its strategy passed to `.with(() => constraints([strategy]))`.
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
 * Needs the `constraints()` plugin installed. `version` matches on Fastify's built-in semver matcher; any other
 * name needs its strategy passed to `.with(() => constraints([strategy]))`. A route whose constraint the request does not satisfy is
 * not matched, and the request falls through to Fastify's not-found. The programmatic form is {@link constraint},
 * applied with `.with(constraint(name, value), ...)`.
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
