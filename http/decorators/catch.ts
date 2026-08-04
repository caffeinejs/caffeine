import { Ctor, Identifier, Injectable, Injection, Tag } from '@caffeinejs/di'
import { kErrorHandler } from '../error/index.js'
import { configureControllerErrorHandler } from './registrar/registrar.js'

/**
 * Registers an error handler for a given error type. Usable in two forms:
 *
 * - **On a class** extending `ErrorHandler<E>` → a global handler, bound as an injectable. The
 *   parameters after `error` mirror `@Injectable` (optional named key and/or constructor deps).
 * - **On a controller method** → a per-controller handler for that error type, invoked with the same
 *   `(ctx, error)` contract as `ErrorHandler.handle`. Takes only the error type; the method runs on
 *   the controller instance, so its deps come from the controller's constructor.
 *
 * A handler registered for a base error type also serves its subclasses. Use `@Catch(Error)` for a
 * catch-all.
 *
 * @param error - The error type this handler renders. Required.
 *
 * @example
 * ```ts
 * // global handler class
 * @Catch(ErrNotFound, [PetRepository])
 * class NotFoundHandler extends ErrorHandler<ErrNotFound> { ... }
 *
 * // per-controller handler method
 * @Controller('/pets')
 * class PetsController {
 *   @Catch(ErrNotFound)
 *   async handleNotFound(ctx: Context, error: ErrNotFound) { ctx.status(404).body({ error: error.message }) }
 * }
 * ```
 */
type CatchDecorator = (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void

export function Catch(error: Ctor<Error>): CatchDecorator
export function Catch(error: Ctor<Error>, key: Identifier): CatchDecorator
export function Catch(error: Ctor<Error>, dependencies: Injection[]): CatchDecorator
export function Catch(error: Ctor<Error>, key: Identifier, dependencies: Injection[]): CatchDecorator
export function Catch(error: Ctor<Error>, keyOrDependencies?: Identifier | Injection[], dependencies?: Injection[]) {
  return (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
    if (context.kind === 'method') {
      configureControllerErrorHandler(context, error)
      return
    }

    const injectable = Injectable as (
      keyOrDependencies?: Identifier | Injection[],
      dependencies?: Injection[],
    ) => (target: Ctor, context: ClassDecoratorContext) => void

    injectable(keyOrDependencies, dependencies)(target as Ctor, context)
    Tag(kErrorHandler, error)(target as Ctor, context)
  }
}
