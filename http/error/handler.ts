import { Container, Ctor, InjectionToken, Provider } from '@caffeinejs/di'

import { Context } from '../context.js'
import { ActionResult } from '../response.js'
import type { CatchByMap } from '../route.js'
import { ErrConfiguration } from './common.js'
import { solutions } from './util.js'

export const kErrorHandler = Symbol('caffeine:http:error_handler')

/**
 * The value attached to a handler class binding under the {@link kErrorHandler} tag by `@Catch`.
 * Read by the enrolled-handler map the error handling feature builds and by the `@CatchWith` resolution in
 * `buildRouting`.
 */
export interface CatchMetadata {
  errors: Ctor<Error>[]
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
 * Renders a response for a thrown error. Decorate the class with `@Catch(ErrType)` to declare the errors it
 * handles, then enrol it — `.errorHandling(e => e.globalHandlers(Handler))` to render that error anywhere in the
 * application, or `@CatchWith(Handler)` to render it for one controller or route.
 *
 * Like a controller handler (and Fastify's own `setErrorHandler`), it may either send the response via
 * `ctx` (e.g. `ctx.status(404)` then `ctx.body(...)`, or `ctx.notFound(...)`) and return nothing, or
 * **return** a value the framework finalizes — a plain object serialized as JSON, or a `View(...)` result
 * rendered as HTML.
 *
 * A handler registered for a base error type also serves its subclasses; register `@Catch(Error)`
 * for a catch-all.
 */
export interface ErrorHandler<E extends Error> {
  // A method rather than a property of function type: a method's parameter is compared bivariantly, which is what
  // keeps an `ErrorHandler<ErrHTTPNotFound>` assignable to the `ErrorHandler<Error>` every map here holds.
  handle(ctx: Context, error: E): Promise<ActionResult> | ActionResult
}

/**
 * A reference to an error handler class, as accepted by `@CatchWith` and
 * `.errorHandling(e => e.globalHandlers(...))`: either the class itself or a name assigned to it with `@Named`.
 * Both are resolved through the container, so `@Primary`, `@ConditionalOn` and `@Profile` apply as they do
 * anywhere else.
 */
export type ErrorHandlerRef = InjectionToken<ErrorHandler<Error>>

// ErrorHandlerProvider holds the mapping of error types to their handlers.
// It's used to resolve the most specific handler for an error by walking its prototype chain.
export class ErrorHandlerProvider {
  constructor(private readonly handlers: Map<Ctor<Error>, Provider<ErrorHandler<Error>>>) {}

  /**
   * Resolves the most specific handler for an error by walking its prototype chain: the error's own
   * class first, then each base class, up to and including `Error` (a `@Catch(Error)` catch-all).
   */
  provide(error: Error): Provider<ErrorHandler<Error>> | undefined {
    return resolveByErrorChain(this.handlers, error)
  }
}

/** How {@link buildCatchByMap} names what it is resolving, so a failure points at the call that declared it. */
export interface CatchByOwner {
  /** What named the handlers, e.g. a controller class or `the application`. */
  owner: string
  /** The declaration a diagnostic tells the reader to look at, e.g. `"@CatchWith"`. */
  declaredBy: string
}

/**
 * Resolves error handler references into a map of error type to handler provider.
 *
 * Resolution goes through the container, so a reference by class or by `@Named` identifier honours `@Primary`,
 * `@ConditionalOn` and `@Profile` like any other injection point. A handler whose binding is absent is refused
 * rather than skipped: a reference that resolves to nothing is a handler the application asked for and did not
 * get.
 *
 * @throws ErrConfiguration when a reference has no binding, is not decorated with `@Catch`, or handles an error
 * type another reference in the same list already handles.
 */
export function buildCatchByMap(
  // Only what resolving a reference needs, so both callers fit: a feature's `configure`, handed
  // `ContainerBindingOps` before the container initializes, and route compilation, handed the whole container
  // after it has.
  container: Pick<Container, 'getBinding' | 'wrapBinding'>,
  refs: readonly ErrorHandlerRef[] | undefined,
  { owner, declaredBy }: CatchByOwner,
): CatchByMap | undefined {
  if (!refs?.length) {
    return undefined
  }

  const map: CatchByMap = new Map()
  const owners = new Map<Ctor<Error>, string>()

  for (const ref of refs) {
    const name = typeof ref === 'function' ? ref.name : String(ref)
    const binding = container.getBinding(ref)
    if (!binding) {
      throw new ErrConfiguration(
        `Cannot resolve error handler "${name}" referenced by "${owner}": no binding registered` +
          solutions(
            `Decorate "${name}" with "@Catch(ErrorType)" so it is registered in the container`,
            'Make sure the handler module is imported by the application',
          ),
      )
    }

    const meta = binding.tags.get(kErrorHandler) as CatchMetadata | undefined
    if (!meta) {
      throw new ErrConfiguration(
        `Cannot use "${name}" as an error handler in "${owner}": it is not decorated with "@Catch"` +
          solutions(`Decorate "${name}" with "@Catch(ErrorType)" to declare the errors it handles`),
      )
    }

    const provider = container.wrapBinding<ErrorHandler<Error>>(binding)
    for (const errorType of meta.errors) {
      const previous = owners.get(errorType)
      if (previous !== undefined) {
        throw new ErrConfiguration(
          `Ambiguous ${declaredBy} in "${owner}": both "${previous}" and "${name}" handle "${errorType.name}"` +
            solutions(`Keep a single handler for "${errorType.name}" in "${owner}"`),
        )
      }

      owners.set(errorType, name)
      map.set(errorType, provider)
    }
  }

  return map
}
