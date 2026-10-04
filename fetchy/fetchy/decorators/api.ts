import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureAPIAndRegisterMethods } from './registrar/registrar.js'

/**
 * Marks a class as a fetchy API client. Mandatory on every class passed to
 * `FetchyClient.create()` — drains that class's decorated methods into the registry `create()`
 * reads. The other class decorators may be listed above or below it.
 *
 * `path` is optional and only overwrites the class-level path when given, so `@API()` can be
 * stacked with a separate `@Path(...)` without clobbering it. When both set a path, the one listed
 * higher wins.
 */
export function API(path?: string) {
  return function (target: Function, context: ClassDecoratorContext): void {
    if (context.kind !== 'class') {
      throw new ErrFetchyInvalidDecoratorTarget('API', 'a class')
    }

    configureAPIAndRegisterMethods(context, target, spec => {
      if (path !== undefined) {
        spec.path(path)
      }
    })
  }
}
