import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './_registrar.js'

export function BodyLimit(bytes: number) {
  return defineClassOrMemberDecorator(
    target => configureRouter(target, spec => spec.bodyLimit(bytes)),
    context => configureRoute(context, spec => spec.bodyLimit(bytes)),
  )
}
