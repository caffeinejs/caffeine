import type { RetryPolicy } from '../error_handling.js'
import { configureListener } from './registrar.js'

/**
 * Sets a per-listener retry policy, overriding the instance default from `app.kafka(k => k.retry(...))`.
 *
 * ```ts
 * @KafkaListener({ topic: 'orders' })
 * @KafkaRetry({ attempts: 3, backoff: { type: 'exponential', delay: 500 } })
 * onOrder(order: Order) { ... }
 * ```
 */
export function KafkaRetry(policy: RetryPolicy) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureListener(context, builder => {
      builder.retry(policy)
    })
  }
}
