import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { Message } from '../message.js'
import { $m, type MessagePickers } from '../pickers.js'
import { configureConsume } from './registrar.js'

type Picks = ParameterPickOptions<Message>[]

/**
 * Declares how a `@Consume` method's arguments are extracted from the message. Mirrors HTTP's `@Args`: pass a
 * function that receives the built-in portable pickers and returns an ordered array, one entry per argument.
 * Without `@MessageParams`, the handler receives the message payload as its single argument.
 *
 * ```ts
 * @Consume('orders')
 * @MessageParams(m => [m.payload(), m.header('trace'), m.context()])
 * onOrder(order: Order, trace: string | Buffer | undefined, ctx: MessageContext) { ... }
 * ```
 */
export function MessageParams(params: Picks): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function MessageParams(
  build: (m: MessagePickers) => Picks,
): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function MessageParams(arg: Picks | ((m: MessagePickers) => Picks)) {
  const params = typeof arg === 'function' ? arg($m) : arg

  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureConsume(context, builder => {
      builder.parameters = params
    })
  }
}
