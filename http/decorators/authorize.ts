import { RouteAuthzOptions } from '../routing/spec.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

export function Authorize(opts: Exclude<RouteAuthzOptions, 'allowAnonymous'> = {}) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.authorize(opts)),
    context => configureRoute(context, spec => spec.authorize(opts)),
  )
}
