import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { classMeta } from '../metadata.js'
import { normalizePath } from '../internal/path_util.js'

/**
 * Sets the base path used as a prefix for every decorated method's path on the class.
 */
export function Path(path: string) {
  return function (_target: Function, context: ClassDecoratorContext): void {
    if (context.kind !== 'class') {
      throw new ErrFetchyInvalidDecoratorTarget('Path', 'a class')
    }

    classMeta(context.metadata).path = normalizePath(path)
  }
}
