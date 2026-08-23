import type { MessageBus } from './bus.js'
import type { Message } from './message.js'

/** Engine-facing ack/nack state a handler mutates through its {@link MessageContext} during one invocation. */
export interface ContextSignals {
  acked: boolean
  nacked: boolean
  nackDelay?: number
}

/** Internal key carrying the {@link ContextSignals} on a context, kept off the public surface. */
export const kSignals = Symbol('@caffeinejs/messaging:context-signals')

/**
 * Per-message context handed to a `@Consume` handler as its second argument: the portable counterpart of Kafka's
 * `KafkaContext`. Exposes the envelope, the current attempt, and the portable ack/nack + publish operations.
 * Binder-native extras (offsets, delivery tags) are not here — reach for the binder package when you need them.
 */
export interface MessageContext<T = unknown> {
  readonly message: Message<T>
  readonly attempt: number
  readonly binding: string
  /** Acknowledges the message (portable at-least-once commit point). */
  ack(): void
  /** Requests in-pipeline redelivery of this message, optionally after `delayMs`. */
  nack(delayMs?: number): void
  /** Publishes to another (outbound) binding through the message bus. */
  send(binding: string, payload: unknown): Promise<void>
}

/** The concrete context the engine builds per invocation; the engine reads its {@link kSignals} afterwards. */
export class MessageContextImpl<T = unknown> implements MessageContext<T> {
  readonly message: Message<T>
  readonly attempt: number
  readonly binding: string
  readonly [kSignals]: ContextSignals = { acked: false, nacked: false }

  readonly #bus: MessageBus

  constructor(message: Message<T>, attempt: number, binding: string, bus: MessageBus) {
    this.message = message
    this.attempt = attempt
    this.binding = binding
    this.#bus = bus
  }

  ack(): void {
    this[kSignals].acked = true
  }

  nack(delayMs?: number): void {
    this[kSignals].nacked = true
    this[kSignals].nackDelay = delayMs
  }

  send(binding: string, payload: unknown): Promise<void> {
    return this.#bus.send(binding, payload)
  }
}
