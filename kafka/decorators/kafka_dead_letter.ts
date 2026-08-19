import type { DeadLetterOptions } from '../error_handling.js'
import { configureListener } from './registrar.js'

/**
 * Enables dead-letter recovery for this listener, overriding the instance default. With no options the failed
 * record is republished to `${topic}.DLT`.
 *
 * ```ts
 * @KafkaListener({ topic: 'orders' })
 * @KafkaDeadLetter()
 * onOrder(order: Order) { ... }
 * ```
 */
export function KafkaDeadLetter(options: DeadLetterOptions = {}) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureListener(context, builder => {
      builder.deadLetter(options)
    })
  }
}
