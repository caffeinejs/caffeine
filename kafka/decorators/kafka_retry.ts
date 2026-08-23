import type { RetryPolicy } from '../error_handling.js'
import type { RetryStrategy } from '../retry/strategy.js'
import { configureListener } from './registrar.js'

// A RetryStrategy has a `dispatch` method; a RetryPolicy is a plain `{ attempts, backoff? }` object.
function isStrategy(value: RetryPolicy | RetryStrategy): value is RetryStrategy {
  return typeof (value as RetryStrategy).dispatch === 'function'
}

/**
 * Sets a per-listener retry policy or strategy, overriding the instance default from `app.kafka(k => k.retry(...))`.
 * A {@link RetryPolicy} becomes blocking retry; pass a strategy (`retryTopics(...)`, `sharedRetryTopic(...)`, or a
 * custom one) for non-blocking retry on just this listener.
 *
 * ```ts
 * @KafkaListener({ topic: 'orders' })
 * @KafkaRetry({ attempts: 3, backoff: { type: 'exponential', delay: 500 } })   // blocking
 * onOrder(order: Order) { ... }
 *
 * @KafkaListener({ topic: 'emails' })
 * @KafkaRetry(retryTopics({ attempts: 4, backoff: { type: 'fixed', delay: 1000 } }))   // non-blocking
 * onEmail(email: Email) { ... }
 * ```
 */
export function KafkaRetry(policy: RetryPolicy | RetryStrategy) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureListener(context, builder => {
      if (isStrategy(policy)) {
        builder.retryStrategy(policy)
      } else {
        builder.retry(policy)
      }
    })
  }
}
