import { type Ctor, type Injection, Injectable, Label } from '@caffeinejs/di'

import { Keys } from '../symbols.js'
import { registerHandler } from './registrar.js'

/** Options for {@link MessageHandler}. */
export interface MessageHandlerOptions {
  /** Constructor injections, forwarded to `@Injectable`. */
  dependencies?: Injection[]
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
export function MessageHandler(options: MessageHandlerOptions = {}) {
  return function (target: Function, context: ClassDecoratorContext): void {
    Injectable(options.dependencies ?? [])(target as Ctor, context)
    Label(Keys.MESSAGE_HANDLER)(target, context)

    registerHandler(context.metadata, target)
  }
}
