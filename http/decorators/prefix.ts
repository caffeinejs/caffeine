import { configureRouteGroup } from './registrar/registrar.js'

export function Prefix(prefix: string) {
  return function (target: Function, context: ClassDecoratorContext): void {
    configureRouteGroup(context, target, spec => spec.prefix(prefix))
  }
}
