import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

export function Consumes(consumes: string | string[]) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.consumes(consumes)),
    context => configureRoute(context, spec => spec.consumes(consumes)),
  )
}
