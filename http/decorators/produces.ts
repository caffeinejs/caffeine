import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRouteGroup, configureRoute } from './registrar/registrar.js'

export function Produces(produces: string) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.produces(produces)),
    context => configureRoute(context, spec => spec.produces(produces)),
  )
}
