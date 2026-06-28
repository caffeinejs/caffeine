import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

export function BodyLimit(bytes: number) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouter(ctx, target, spec => spec.bodyLimit(bytes)),
    context => configureRoute(context, spec => spec.bodyLimit(bytes)),
  )
}
