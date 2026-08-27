import { validateSchema } from '@caffeinejs/std/schema'
import type { BoundProducer } from './binder.js'
import { ErrMessageValidation, ErrUnknownBinder, ErrUnknownBinding } from './errors.js'
import { isMessage, type Message, message as toMessage } from './message.js'
import type { MessagingRuntime } from './runtime.js'

/**
 * The imperative publish API. `send('binding', payload)` resolves the outbound binding, lazily opens (and caches)
 * that binding's producer on its binder, and publishes. Injected wherever a component needs to produce, and
 * handed to `@Consume` handlers via `ctx.send(...)`.
 */
export class MessageBus {
  readonly #runtime: MessagingRuntime
  readonly #producers = new Map<string, BoundProducer>()

  constructor(runtime: MessagingRuntime) {
    this.#runtime = runtime
  }

  /** Publishes a payload (wrapped into a {@link Message}) or a full {@link Message} to an outbound binding. */
  async send(binding: string, payload: unknown | Message): Promise<void> {
    let message = isMessage(payload) ? payload : toMessage(payload)

    const schema = this.#runtime.outbound.get(binding)?.schema
    if (schema !== undefined) {
      const result = validateSchema(schema, message.payload)
      if (!result.ok) {
        throw new ErrMessageValidation(binding, result.issues)
      }
      message = { ...message, payload: result.value }
    }

    const producer = await this.#producerFor(binding)
    await producer.send(message)
  }

  /** Eagerly opens every outbound binding's producer (fail-fast at startup instead of on first send). */
  async warmUp(): Promise<void> {
    for (const binding of this.#runtime.outbound.keys()) {
      await this.#producerFor(binding)
    }
  }

  async #producerFor(binding: string): Promise<BoundProducer> {
    const cached = this.#producers.get(binding)
    if (cached !== undefined) {
      return cached
    }

    const spec = this.#runtime.outbound.get(binding)
    if (spec === undefined) {
      throw new ErrUnknownBinding(binding, 'outbound')
    }
    const binder = this.#runtime.binders.get(spec.via)
    if (binder === undefined) {
      throw new ErrUnknownBinder(binding, spec.via, [...this.#runtime.binders.keys()])
    }

    const producer = await binder.bindProducer(spec)
    this.#producers.set(binding, producer)
    return producer
  }
}
