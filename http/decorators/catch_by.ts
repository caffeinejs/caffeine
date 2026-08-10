import type { ErrorHandlerRef } from '../error/index.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

/**
 * Attaches error handler classes to a controller or to a single route.
 *
 * Handlers are referenced by class, or by a name given to them with `@Named`, and are resolved through
 * the container — `@Primary`, `@ConditionalOn` and `@Profile` apply as usual. The error types a handler
 * serves come from its own `@Catch` declaration.
 *
 * Precedence, most specific first: the route's `@CatchBy`, the controller's `@CatchBy`, a `@Catch`
 * method on the controller, then the global handler. A handler declared `@Catch(E, { global: false })`
 * is reachable only this way.
 *
 * @param handlers - Error handler classes, or `@Named` identifiers of error handler classes.
 *
 * @example
 * ```ts
 * @CatchBy(PetsNotFoundHandler)
 * @Controller('/pets')
 * class PetsController {
 *   @CatchBy('strictValidation')
 *   @Post('/')
 *   create() { ... }
 * }
 * ```
 */
export function CatchBy(...handlers: ErrorHandlerRef[]) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => spec.catchBy(handlers))
    } else {
      configureRoute(context, spec => spec.catchBy(handlers))
    }
  }
}
