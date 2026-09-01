import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

export function Timeout(ms: number) {
  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.timeout(ms)),
    context => configureRoute(context, spec => spec.timeout(ms)),
  )
}
