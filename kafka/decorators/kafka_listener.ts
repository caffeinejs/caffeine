import type { KafkaDeserializers } from '../config.js'
import { configureListener } from './registrar.js'

/** Options for a `@KafkaListener` method. Either `topic` or `topics` is required. */
export interface KafkaListenerOptions {
  /** A single topic to subscribe to. */
  topic?: string
  /** Multiple topics to subscribe to. */
  topics?: string[]
  /** Consumer group id; falls back to the plugin default `groupId` when omitted. */
  groupId?: string
  /** Overrides the consumer autocommit behaviour for this listener. */
  autocommit?: boolean | number
  /** Per-listener deserializers; runs this listener on its own consumer (overrides the instance default). */
  deserializers?: KafkaDeserializers
}

/**
 * Marks a method as a Kafka topic listener — invoked once per message on the subscribed topic(s). The class
 * must be decorated with `@KafkaHandler`. Mirrors Spring's `@KafkaListener`.
 *
 * ```ts
 * @KafkaListener({ topic: 'orders', groupId: 'orders-service' })
 * onOrder(message: KafkaMessage) { ... }
 * ```
 */
export function KafkaListener(options: KafkaListenerOptions) {
  const topics = options.topics ?? (options.topic !== undefined ? [options.topic] : [])

  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureListener(context, builder => {
      builder.handler(context.name).topics(topics)
      if (options.groupId !== undefined) {
        builder.groupId(options.groupId)
      }
      if (options.autocommit !== undefined) {
        builder.autocommit(options.autocommit)
      }
      if (options.deserializers !== undefined) {
        builder.deserializers(options.deserializers)
      }
    })
  }
}
