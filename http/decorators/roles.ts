import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Requires the caller to hold any one of `roles`. Shorthand for `@Authorize({ roles })`.
 *
 * Written twice, it requires both: `@Roles('admin', 'manager')` admits an admin or a manager, while `@Roles('admin')`
 * next to `@Roles('manager')` admits only a caller who is both. The same holds across levels — a controller's
 * roles and a method's are each required.
 */
export function Roles(...roles: string[]) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.authorize({ roles })),
    context => configureRoute(context, spec => spec.authorize({ roles })),
  )
}
