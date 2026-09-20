import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Declares a route, or every route of a controller, public.
 *
 * On a controller it opens the methods that declare nothing themselves. A method carrying `@Authorize` or `@Roles`
 * of its own stays protected, by that declaration and by whatever a level above the controller required. On a
 * method it opens that method whatever the controller declared.
 */
export function AllowAnonymous() {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.authorize({ allowAnonymous: true })),
    context => configureRoute(context, spec => spec.authorize({ allowAnonymous: true })),
  )
}
