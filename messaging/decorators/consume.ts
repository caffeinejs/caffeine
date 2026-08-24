import { configureConsume } from './registrar.js'

/**
 * Marks a method as the handler for one inbound binding — invoked once per message delivered to that binding.
 * The class must be decorated with `@MessageHandler`. `binding` is the logical binding name declared on the
 * messaging builder (`.in('orders', { destination, via })`), not a physical destination.
 *
 * ```ts
 * @Consume('orders')
 * async handle(order: Order, ctx: MessageContext) { ... }
 * ```
 *
 * For binder-native listener power (partitions, ack mode, per-listener deserializers), use the binder package's
 * own superset decorator (`@KafkaListener`) — it registers into the same engine.
 */
export function Consume(binding: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureConsume(context, builder => {
      builder.binding = binding
    })
  }
}
