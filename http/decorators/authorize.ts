import { RouteAuthzOptions } from './registrar/routing.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

export function Authorize(opts: Exclude<RouteAuthzOptions, 'allowAnonymous'> = {}) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouter(context, target, spec => spec.authorize(opts)),
    context => configureRoute(context, spec => spec.authorize(opts)),
  )
}
