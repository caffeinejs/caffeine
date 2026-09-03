import { type Ctor, type InjectionsFor, Injectable, Label, Tag } from '@caffeinejs/di'

import { DEFAULT_INSTANCE, Keys } from '../symbols.js'
import { registerHandler } from './registrar.js'

/** Options for {@link KafkaHandler}. */
export interface KafkaHandlerOptions<A extends unknown[] = []> {
  /** The named kafka instance this handler belongs to. Defaults to the unnamed default instance. */
  instance?: string
  /** Constructor injections, forwarded to `@Injectable`. */
  dependencies?: [...InjectionsFor<A>]
}

/**
 * Marks a class as a Kafka message handler. It is registered as an injectable DI component, labelled for
 * discovery, and tagged with the name of the kafka instance it belongs to, so the matching
 * `KafkaListenerContainer` wires its `@KafkaListener` methods. Plays the same role for Kafka that
 * `@Controller` plays for HTTP.
 *
 * ```ts
 * @KafkaHandler({ instance: 'orders' })
 * class OrdersConsumer {
 *   @KafkaListener({ topic: 'orders', groupId: 'orders-service' })
 *   onOrder(message: KafkaMessage) { ... }
 * }
 * ```
 */
export function KafkaHandler<A extends unknown[] = []>(options: KafkaHandlerOptions<A> = {}) {
  const instance = options.instance ?? DEFAULT_INSTANCE

  return function (target: Ctor<unknown, A>, context: ClassDecoratorContext): void {
    if (options.dependencies === undefined) {
      Injectable()(target as Ctor<unknown, []>, context)
    } else {
      Injectable(options.dependencies)(target, context)
    }
    Label(Keys.KAFKA_HANDLER)(target, context)
    Tag(Keys.KAFKA_INSTANCE, instance)(target, context)

    registerHandler(context.metadata, target)
  }
}
