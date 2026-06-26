import { configureRouter } from './registrar/registrar.js'

export function Prefix(prefix: string) {
  return function (target: Function, _context: ClassDecoratorContext): void {
    configureRouter(target, spec => spec.prefix(prefix))
  }
}
