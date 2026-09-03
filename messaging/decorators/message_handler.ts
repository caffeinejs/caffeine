import { type Ctor, type InjectionsFor, Injectable, Label } from '@caffeinejs/di'

import { Keys } from '../symbols.js'
import { registerHandler } from './registrar.js'

/** Options for {@link MessageHandler}. */
export interface MessageHandlerOptions<A extends unknown[] = []> {
  /** Constructor injections, forwarded to `@Injectable`. */
  dependencies?: [...InjectionsFor<A>]
}

/**
 * Marks a class as a portable message handler. Registered as an injectable DI component and labelled for
 * discovery, so the messaging engine wires its `@Consume` methods to their bindings. The binder that delivers to
 * each binding is decided by the binding's `via` in the registry — the handler itself is binder-agnostic. Plays
 * the same role for messaging that `@Controller` plays for HTTP.
 *
 * ```ts
 * @MessageHandler()
 * class Workers {
 *   @Consume('orders')
 *   async handle(order: Order, ctx: MessageContext) { ... }
 * }
 * ```
 */
export function MessageHandler<A extends unknown[] = []>(options: MessageHandlerOptions<A> = {}) {
  return function (target: Ctor<unknown, A>, context: ClassDecoratorContext): void {
    if (options.dependencies === undefined) {
      Injectable()(target as Ctor<unknown, []>, context)
    } else {
      Injectable(options.dependencies)(target, context)
    }
    Label(Keys.MESSAGE_HANDLER)(target, context)

    registerHandler(context.metadata, target)
  }
}
