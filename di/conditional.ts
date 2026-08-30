import { InjectionToken } from './key.js'
import { Binding } from './binding.js'

/**
 * Context for a {@link Conditional} function.
 */
export interface ConditionContext {
  readonly container: {
    /**
     * Checks if a binding is registered for the given key.
     */
    has: (key: InjectionToken) => boolean
  }
  readonly key: InjectionToken
  readonly binding: Binding
}

/**
 * Conditional is predicate that is used to determine if a binding should be registered.
 * It is evaluated during the container initialization phase once.
 * Async conditionals are supported.
 *
 * @param ctx - The context for the conditional.
 * @returns `true` if the binding should be registered, `false` otherwise.
 */
export type Conditional = (ctx: ConditionContext) => boolean | Promise<boolean>
