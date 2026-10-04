import { ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureMethod } from './registrar/registrar.js'

/**
 * Cancels an inherited class-level `@Retry()` for this method (or field-declared operation).
 */
export function NoRetry() {
  return function (_value: unknown, context: ClassMethodDecoratorContext | ClassFieldDecoratorContext): void {
    if ((context.kind !== 'method' && context.kind !== 'field') || context.static) {
      throw new ErrFetchyInvalidDecoratorTarget('NoRetry', 'an instance method or field')
    }

    configureMethod(context, spec => spec.noRetry(true))
  }
}
