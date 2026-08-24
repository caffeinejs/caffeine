import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

export function Consumes(consumes: string | string[]) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouter(ctx, target, spec => spec.consumes(consumes)),
    context => configureRoute(context, spec => spec.consumes(consumes)),
  )
}
