import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

// Shorthand for @Authorize({ roles }): enables authorization gated by the listed roles.
export function Roles(...roles: string[]) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.authorize({ roles })),
    context => configureRoute(context, spec => spec.authorize({ roles })),
  )
}
