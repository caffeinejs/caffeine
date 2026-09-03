import { type Ctor, type Injection, Injectable, Label, Tag } from '@caffeinejs/di'

import { DEFAULT_INSTANCE, Keys } from '../symbols.js'
import { registerHandler } from './registrar.js'

/** Options for {@link KafkaHandler}. */
export interface KafkaHandlerOptions {
  /** The named kafka instance this handler belongs to. Defaults to the unnamed default instance. */
  instance?: string
  /** Constructor injections, forwarded to `@Injectable`. */
  dependencies?: Injection[]
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
export function KafkaHandler(options: KafkaHandlerOptions = {}) {
  const instance = options.instance ?? DEFAULT_INSTANCE

  return function (target: Function, context: ClassDecoratorContext): void {
    Injectable(options.dependencies ?? [])(target as Ctor, context)
    Label(Keys.KAFKA_HANDLER)(target, context)
    Tag(Keys.KAFKA_INSTANCE, instance)(target, context)

    registerHandler(context.metadata, target)
  }
}
