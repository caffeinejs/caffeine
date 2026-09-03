import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { KafkaMessage } from '../config.js'
import { $k, type KafkaPickers } from '../pickers.js'
import { configureListener } from './registrar.js'

type Picks = ParameterPickOptions<KafkaMessage>[]

/**
 * Declares how a `@KafkaListener` method's arguments are extracted from the message. Mirrors HTTP's `@Args`:
 * pass a function that receives the built-in Kafka pickers and returns an ordered array, one entry per
 * argument. Without `@KafkaParams`, the handler receives the whole {@link KafkaMessage}.
 *
 * ```ts
 * @KafkaListener({ topic: 'orders' })
 * @KafkaParams(k => [k.value(), k.key(), k.header('trace')])
 * onOrder(order: Order, key: string, trace: string) { ... }
 * ```
 */
export function KafkaParams(params: Picks): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function KafkaParams(
  build: (k: KafkaPickers) => Picks,
): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function KafkaParams(arg: Picks | ((k: KafkaPickers) => Picks)) {
  const params = typeof arg === 'function' ? arg($k) : arg

  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureListener(context, builder => {
      builder.parameters(params)
    })
  }
}
