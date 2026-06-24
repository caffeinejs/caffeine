import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './_registrar.js'

export function Timeout(ms: number) {
  return defineClassOrMemberDecorator(
    target => configureRouter(target, spec => spec.timeout(ms)),
    context => configureRoute(context, spec => spec.timeout(ms)),
  )
}
