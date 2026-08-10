import { Ctor, Identifier, Provider, Scopes } from '@caffeinejs/di'
import { Context } from '../context.js'
import { kServiceConfigure, Service, ServiceKit } from '../service.js'
import { ErrConfiguration } from './common.js'
import { solutions } from './util.js'

export const kErrorHandler = Symbol('caffeine:http:error_handler')

/**
 * The value attached to a handler class binding under the {@link kErrorHandler} tag by `@Catch`.
 * Read by the global handler scan and by the `@CatchBy` resolution in `buildRouting`.
 */
export interface CatchMetadata {
  errors: Ctor<Error>[]
  global: boolean
}

/**
 * Resolves the value mapped to an error by walking its prototype chain: the error's own class first,
 * then each base class, up to and including `Error` (the catch-all key).
 * Returns `undefined` when nothing matches.
 * Shared by the global handler provider and the per-controller handler lookup.
 */
export function resolveByErrorChain<T>(map: Map<Ctor<Error>, T>, error: Error): T | undefined {
  let ctor: Function | undefined = error.constructor
  while (ctor && ctor !== Function.prototype) {
    const value = map.get(ctor as Ctor<Error>)
    if (value !== undefined) {
      return value
    }

    ctor = Object.getPrototypeOf(ctor) as Function | undefined
  }

  return undefined
}

/**
 * Base class for error handlers. Extend it and decorate with `@Catch(ErrType)` to render a
 * response for a given error type. The handler sends the response via `ctx` (e.g. `ctx.status(404)`
 * then `ctx.body(...)`, or `ctx.notFound(...)`) and resolves; it does not return a value.
 *
 * A handler registered for a base error type also serves its subclasses; register `@Catch(Error)`
 * for a catch-all.
 */
export abstract class ErrorHandler<E extends Error> {
  abstract handle(ctx: Context, error: E): Promise<void>
}

/**
 * A reference to an error handler class, as accepted by `@CatchBy`: either the class itself or a name
 * assigned to it with `@Named`. Both are resolved through the container, so `@Primary`, `@ConditionalOn`
 * and `@Profile` apply as they do anywhere else.
 */
export type ErrorHandlerRef = Ctor<ErrorHandler<Error>> | Identifier

// ErrorHandlerProvider holds the mapping of error types to their handlers.
// It's used to resolve the most specific handler for an error by walking its prototype chain.
export class ErrorHandlerProvider {
  constructor(
    private readonly handlers: Map<Ctor<Error>, Provider<ErrorHandler<Error>>>,
  ) {}

  /**
   * Resolves the most specific handler for an error by walking its prototype chain: the error's own
   * class first, then each base class, up to and including `Error` (a `@Catch(Error)` catch-all).
   */
  handlerFor(error: Error): Provider<ErrorHandler<Error>> | undefined {
    return resolveByErrorChain(this.handlers, error)
  }
}

export class ErrorHandlingServiceConfigurer implements Service {
  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    const handlerBinding = kit.container.getBindings(ErrorHandler)
    const handlers = new Map<Ctor<Error>, Provider<ErrorHandler<Error>>>()

    for (const errorHandler of handlerBinding) {
      const meta = errorHandler.tags.get(kErrorHandler) as CatchMetadata | undefined
      if (!meta) {
        const name = errorHandler.type?.name ?? '<anonymous>'
        throw new ErrConfiguration(
          `Error handler "${name}" does not declare an error type`
          + solutions(
            `Decorate "${name}" with "@Catch(ErrorType)" to bind it to a specific error`,
            'Use "@Catch(Error)" to register it as a catch-all handler',
          ),
        )
      }

      // Non-global handlers stay bound in the container — reachable only through "@CatchBy" on a
      // controller or route — so they never compete with the global handler for the same error type.
      if (!meta.global) {
        continue
      }

      const provider = kit.container.wrapBinding(errorHandler)
      for (const err of meta.errors) {
        if (handlers.has(err)) {
          throw new ErrConfiguration(
            `Ambiguous error handler: multiple handlers registered for "${err.name}"`
            + solutions(
              `Remove the duplicate "@Catch(${err.name})" handler so only one handles this error type`,
              `Mark one of them "@Catch(${err.name}, { global: false })" and attach it with "@CatchBy" on the controller or route that needs it`,
            ),
          )
        }

        handlers.set(err, provider)
      }
    }

    kit.container.bind(ErrorHandlerProvider)
      .toValue(new ErrorHandlerProvider(handlers))
      .lifetime(Scopes.SINGLETON)
      .internal()

    return Promise.resolve()
  }
}
