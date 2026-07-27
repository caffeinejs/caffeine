import type { CallAdapter } from '../../call_adapter.js'
import { ErrFetchyMissingCallbackArgument } from '../../errors.js'

type Callback = (error: Error | null, response: unknown) => void

/**
 * Adapts a `Promise`-returning invoker into Node-style callback invocation: the last call
 * argument is called with `(error, response)` instead of the invoker's promise being returned.
 */
export class CallbackCallAdapter implements CallAdapter<(...args: unknown[]) => void> {
  static readonly INSTANCE = new CallbackCallAdapter()

  adapt(invoker: (...args: unknown[]) => Promise<unknown>): (...args: unknown[]) => void {
    return (...args: unknown[]): void => {
      const callback = args[args.length - 1]

      if (typeof callback !== 'function') {
        throw new ErrFetchyMissingCallbackArgument()
      }

      invoker(...args).then(
        response => (callback as Callback)(null, response),
        error => (callback as Callback)(error, null),
      )
    }
  }
}
