import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/index.js'

export function GuardOptions<K extends string | symbol, T = unknown>(key: K, options: T) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.guardOptions(key, options)),
    context => configureRoute(context, spec => spec.guardOptions(key, options)),
  )
}
