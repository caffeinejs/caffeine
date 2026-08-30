import type { ErrorHandlerRef } from '../error/index.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

/**
 * Attaches error handler classes to a controller or to a single route.
 *
 * Handlers are referenced by class, or by a name given to them with `@Named`, and are resolved through
 * the container — `@Primary`, `@ConditionalOn` and `@Profile` apply as usual. The error types a handler
 * serves come from its own `@Catch` declaration.
 *
 * Precedence, most specific first: the route's `@CatchWith`, the controller's `@CatchWith`, a `@Catch`
 * method on the controller, then the global handler. A handler declared `@Catch(E, { global: false })`
 * is reachable only this way.
 *
 * @param handlers - Error handler classes, or named tokens of error handler classes.
 *
 * @example
 * ```ts
 * @CatchWith(PetsNotFoundHandler)
 * @Controller('/pets')
 * class PetsController {
 *   @CatchWith(token<ErrorHandler>('strictValidation'))
 *   @Post('/')
 *   create() { ... }
 * }
 * ```
 */
export function CatchWith(...handlers: ErrorHandlerRef[]) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => spec.catchBy(handlers))
    } else {
      configureRoute(context, spec => spec.catchBy(handlers))
    }
  }
}
