import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureMethod } from './registrar/registrar.js'

/**
 * Opts a method (or field-declared operation) into Node-style callback invocation via
 * `CallbackCallAdapterFactory` (`builtin/callback`) — the last call argument becomes an
 * `(error, response) => void` callback instead of the method returning a `Promise`.
 */
export function Callback() {
  return function (_value: unknown, context: ClassMethodDecoratorContext | ClassFieldDecoratorContext): void {
    if (context.kind !== 'method' && context.kind !== 'field') {
      throw new ErrFetchyInvalidDecoratorTarget('Callback', 'a method or field')
    }

    configureMethod(context, spec => spec.callback(true))
  }
}
