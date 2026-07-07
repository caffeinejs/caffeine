import { FastifyCompressOptions } from '@fastify/compress'
import { configureRoute, configureRouter } from './registrar/registrar.js'

export function Compress(options: FastifyCompressOptions | false) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => spec.options('compress', options))
    } else {
      configureRoute(context, spec => spec.options('compress', options))
    }
  }
}
