import type { MethodMeta } from './metadata.js'

/**
 * Adapts the final (already request-built, intercepted, converted) method invoker into a
 * different return shape than the default `Promise<T>` — e.g. a Node-style callback. Ships as an
 * extension point in v1 with no concrete adapter registered by default.
 */
export interface CallAdapter<T> {
  adapt(invoker: (...args: unknown[]) => Promise<unknown>): T
}

export interface CallAdapterFactory {
  provide(meta: MethodMeta): CallAdapter<unknown> | null
}
