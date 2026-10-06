import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureClass } from './registrar/registrar.js'

/**
 * Marks a class as a fetchy API client. `FetchyClient.create()` accepts a class that carries it, or
 * that extends one that does. The other class decorators may be listed above or below it.
 *
 * `path`, when given, prefixes the path of every operation the client serves, inherited ones
 * included. A subclass's `@API(path)` replaces the path its base classes set: `@API('')` removes
 * it, and `@API()` keeps it.
 */
export function API(path?: string) {
  return function (_target: Function, context: ClassDecoratorContext): void {
    if (context.kind !== 'class') {
      throw new ErrFetchyInvalidDecoratorTarget('API', 'a class')
    }

    configureClass(context, spec => {
      spec.api()

      if (path !== undefined) {
        spec.path(path)
      }
    })
  }
}
