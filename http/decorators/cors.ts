import { FastifyCorsOptions } from '@fastify/cors'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

export function CORS(options: FastifyCorsOptions | boolean) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, spec => spec.config('cors', options))
    } else {
      configureRoute(context, spec => spec.config('cors', options))
    }
  }
}
