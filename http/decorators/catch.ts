import { Ctor, ErrInvalidDecorator, Injectable, Injection, Tag, type InjectionsFor } from '@caffeinejs/di'

import { CatchMetadata, kErrorHandler } from '../error/index.js'
import { configureControllerErrorHandler } from './registrar/registrar.js'

/**
 * Options accepted by `@Catch` on a handler class.
 */
export interface CatchOptions {
  /**
   * Whether the handler is registered in the application-wide handler map. Defaults to `true`.
   *
   * Set it to `false` when the handler is meant to serve a single controller or route: the class stays
   * bound in the container and remains reachable through `@CatchWith`, but no longer competes with the
   * global handler for the same error type.
   */
  global?: boolean
}

/**
 * Registers an error handler for one or more error types. Usable in two forms:
 *
 * - **On a class** extending `ErrorHandler<E>` → a handler bound as an injectable. Global by default;
 *   pass `{ global: false }` to restrict it to the controllers and routes that name it with `@CatchWith`.
 *   To resolve it by name from `@CatchWith`, decorate the class with `@Named`.
 * - **On a controller method** → a per-controller handler for those error types, invoked with the same
 *   `(ctx, error)` contract as `ErrorHandler.handle`. Takes only the error types; the method runs on the
 *   controller instance, so its deps come from the controller's constructor.
 *
 * A handler registered for a base error type also serves its subclasses. Use `@Catch(Error)` for a
 * catch-all.
 *
 * @param errors - The error type, or types, this handler renders. Required.
 * @param dependencies - Constructor injections, mirroring `@Injectable`. Class form only.
 * @param options - See {@link CatchOptions}. Class form only.
 *
 * @example
 * ```ts
 * // global handler class, for two error types, with a dependency
 * @Catch([ErrHTTPNotFound, ErrHTTPGone], [PetRepository])
 * class MissingPetHandler extends ErrorHandler<ErrHTTPNotFound | ErrHTTPGone> { ... }
 *
 * // handler class reserved for whoever names it with @CatchWith
 * @Catch(ErrHTTPNotFound, { global: false })
 * class PetsNotFoundHandler extends ErrorHandler<ErrHTTPNotFound> { ... }
 *
 * // per-controller handler method
 * @Controller('/pets')
 * class PetsController {
 *   @Catch(ErrHTTPNotFound)
 *   async handleNotFound(ctx: Context, error: ErrHTTPNotFound) { ctx.status(404).body({ error: error.message }) }
 * }
 * ```
 */
type CatchDecorator = (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void

/** Dependencies apply to a handler class only — a `@Catch` method takes error types and nothing else. */
type CatchClassDecorator<A extends unknown[]> = (target: Ctor<unknown, A>, context: ClassDecoratorContext) => void

export function Catch(errors: Ctor<Error> | Ctor<Error>[]): CatchDecorator
export function Catch<A extends unknown[]>(
  errors: Ctor<Error> | Ctor<Error>[],
  dependencies: [...InjectionsFor<A>],
): CatchClassDecorator<A>
export function Catch(errors: Ctor<Error> | Ctor<Error>[], options: CatchOptions): CatchDecorator
export function Catch<A extends unknown[]>(
  errors: Ctor<Error> | Ctor<Error>[],
  dependencies: [...InjectionsFor<A>],
  options: CatchOptions,
): CatchClassDecorator<A>
export function Catch(
  errors: Ctor<Error> | Ctor<Error>[],
  dependenciesOrOptions?: Injection[] | CatchOptions,
  options?: CatchOptions,
) {
  const errorTypes = Array.isArray(errors) ? [...errors] : [errors]
  if (errorTypes.length === 0) {
    throw new ErrInvalidDecorator(`@${Catch.name}() requires at least one error type`)
  }

  const dependencies = Array.isArray(dependenciesOrOptions) ? dependenciesOrOptions : []
  const opts = Array.isArray(dependenciesOrOptions) ? options : dependenciesOrOptions
  const hasClassOnlyArgs = dependenciesOrOptions !== undefined || options !== undefined

  return (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
    if (context.kind === 'method') {
      if (hasClassOnlyArgs) {
        throw new ErrInvalidDecorator(
          `@${Catch.name}() on method "${String(context.name)}" only accepts error types: ` +
            'dependencies and options apply to handler classes',
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
    const metadata: CatchMetadata = { errors: errorTypes, global: opts?.global ?? true }

    injectable(dependencies)(target as Ctor, context)
    Tag(kErrorHandler, metadata)(target as Ctor, context)
  }
}
