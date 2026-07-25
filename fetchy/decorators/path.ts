import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureClass } from './registrar/registrar.js'

/**
 * Sets the base path used as a prefix for every decorated method's path on the class.
 */
export function Path(path: string) {
  return function (_target: Function, context: ClassDecoratorContext): void {
    if (context.kind !== 'class') {
      throw new ErrFetchyInvalidDecoratorTarget('Path', 'a class')
    }

    configureClass(context, spec => spec.path(path))
  }
}
