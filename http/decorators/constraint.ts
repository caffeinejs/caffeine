import type { AnyRouteExtension } from '../routing/programmatic/extension.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Route/group extension that selects on a registered route constraint. One implementation behind
 * {@link Constraint}, `Router.constraint()` and `RouteChain.constraint()` — never a second copy.
 */
export function constraint(name: string, value: unknown): AnyRouteExtension {
  return (target: { constraint(key: string, value: unknown): unknown }) => {
    target.constraint(name, value)
  }
}

/**
 * Selects the route — or every route of the group, on a class — when the request carries `value` for the
 * constraint `name`.
 *
 * `name` must be a registered constraint: `version` always is, others come from `app.constraints(...)`. A route
 * whose constraint the request does not satisfy is not matched, and the request falls through to Fastify's
 * not-found. The programmatic form is {@link constraint} and `Router.constraint()` / `RouteChain.constraint()`.
 */
export function Constraint(name: string, value: unknown) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, constraint(name, value))
    } else {
      configureRoute(context, constraint(name, value))
    }
  }
}
