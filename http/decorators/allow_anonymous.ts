import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

export function AllowAnonymous() {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.authorize({ allowAnonymous: true })),
    context => configureRoute(context, spec => spec.authorize({ allowAnonymous: true })),
  )
}
