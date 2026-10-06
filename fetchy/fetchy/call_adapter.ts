import type { MethodSpec } from './decorators/registrar/index.js'

/**
 * Adapts an operation's invoker (request already built, intercepted and converted) into a different
 * call shape than the default `Promise<T>`, such as a Node-style callback.
 *
 * The function `adapt()` returns is what a call to the operation runs, without a receiver.
 */
export interface CallAdapter<T extends (...args: never[]) => unknown = (...args: never[]) => unknown> {
  adapt(invoker: (...args: unknown[]) => Promise<unknown>): T
}

export interface CallAdapterFactory {
  provide(spec: MethodSpec): CallAdapter | null
}
