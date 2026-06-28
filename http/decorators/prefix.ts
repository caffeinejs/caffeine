import { configureRouter } from './registrar/registrar.js'

export function Prefix(prefix: string) {
  return function (target: Function, context: ClassDecoratorContext): void {
    configureRouter(context, target, spec => spec.prefix(prefix))
  }
}
