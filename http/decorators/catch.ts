import { Ctor, ErrInvalidDecorator, Injectable, Injection, Tag, type InjectionsFor } from '@caffeinejs/di'

import { CatchMetadata, kErrorHandler } from '../error/index.js'
import { configureControllerErrorHandler } from './registrar/registrar.js'

type CatchDecorator = (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void

/** Dependencies apply to a handler class only — a `@Catch` method takes error types and nothing else. */
type CatchClassDecorator<A extends unknown[]> = (target: Ctor<unknown, A>, context: ClassDecoratorContext) => void

/**
 * Declares the error types a handler renders. Usable in two forms:
 *
 * - **On a class** implementing `ErrorHandler<E>` → a handler bound as an injectable. Decorating it does not
 *   put it to work: the application enrols it with `.errorHandling(e => e.globalHandlers(Handler))` to render
 *   that error anywhere, or a controller or route names it with `@CatchWith`. To resolve it by name from
 *   either, decorate the class with `@Named`.
 * - **On a controller method** → a per-controller handler for those error types, invoked with the same
 *   `(ctx, error)` contract as `ErrorHandler.handle`. The method runs on the controller instance, so its deps
 *   come from the controller's constructor.
 *
 * A handler registered for a base error type also serves its subclasses. Use `@Catch(Error)` for a
 * catch-all.
 *
 * @param errors - The error type, or types, this handler renders. Required.
 * @param dependencies - Constructor injections, mirroring `@Injectable`. Class form only.
 * @throws ErrInvalidDecorator when no error type is given, or when a method form is handed dependencies.
 *
 * @example
 * ```ts
 * // handler class, for two error types, with a dependency
 * @Catch([ErrHTTPNotFound, ErrHTTPGone], [PetRepository])
 * class MissingPetHandler implements ErrorHandler<ErrHTTPNotFound | ErrHTTPGone> { ... }
 *
 * // per-controller handler method
 * @Controller('/pets')
 * class PetsController {
 *   @Catch(ErrHTTPNotFound)
 *   async handleNotFound(ctx: Context, error: ErrHTTPNotFound) { ctx.status(404).body({ error: error.message }) }
 * }
 * ```
 */
export function Catch(errors: Ctor<Error> | Ctor<Error>[]): CatchDecorator
export function Catch<A extends unknown[]>(
  errors: Ctor<Error> | Ctor<Error>[],
  dependencies: [...InjectionsFor<A>],
): CatchClassDecorator<A>
export function Catch(errors: Ctor<Error> | Ctor<Error>[], dependencies?: Injection[]) {
  const errorTypes = Array.isArray(errors) ? [...errors] : [errors]
  if (errorTypes.length === 0) {
    throw new ErrInvalidDecorator(`@${Catch.name}() requires at least one error type`)
  }

  return (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
    if (context.kind === 'method') {
      if (dependencies !== undefined) {
        throw new ErrInvalidDecorator(
          `@${Catch.name}() on method "${String(context.name)}" only accepts error types: ` +
            'dependencies apply to handler classes',
        )
      }

      configureControllerErrorHandler(context, errorTypes)

      return
    }

    // The positional check lives on this function's overloads. Inside the implementation the list has widened
    // back to `Injection[]`, exactly as it has inside `@Injectable`'s own implementation, so the call is cast.
    const injectable = Injectable as (
      dependencies: Injection[],
    ) => (target: Ctor, context: ClassDecoratorContext) => void
    const metadata: CatchMetadata = { errors: errorTypes }

    injectable(dependencies ?? [])(target as Ctor, context)
    Tag(kErrorHandler, metadata)(target as Ctor, context)
  }
}
