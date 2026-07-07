import { FastifyCorsOptions } from '@fastify/cors'
import { configureRoute, configureRouter } from './registrar/registrar.js'

export function CORS(options: FastifyCorsOptions | boolean) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => spec.config('cors', options))
    } else {
      configureRoute(context, spec => spec.config('cors', options))
    }
  }
}
