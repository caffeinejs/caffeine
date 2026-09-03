import type { Binder, BoundConsumer, BoundProducer, DeliveryControl, Dispatch } from './binder.js'
import type { ConsumerBinding, ProducerBinding } from './binding.js'
import type { Message } from './message.js'

/**
 * A minimal in-process broker: destinations to subscriber callbacks. Not a real transport — it exists to prove
 * the messaging engine drives a binder that is not Kafka, and to bridge two binder instances in one process.
 */
export class InMemoryBroker {
  readonly #subscribers = new Map<string, Set<(message: Message) => void>>()
  /** Every message published, in order — for test assertions. */
  readonly published: Array<{ destination: string; message: Message }> = []

  subscribe(destination: string, handler: (message: Message) => void): () => void {
    const set = this.#subscribers.get(destination) ?? new Set()
    set.add(handler)
    this.#subscribers.set(destination, set)
    return () => set.delete(handler)
  }

  publish(destination: string, message: Message): void {
    this.published.push({ destination, message })
    for (const handler of this.#subscribers.get(destination) ?? []) {
      handler(message)
    }
  }

  clear(): void {
    this.#subscribers.clear()
  }
}

/** The control a delivered in-memory message carries: source is the destination, no offsets, forward republishes. */
class InMemoryControl implements DeliveryControl {
  readonly source: string
  readonly attempt = 1

  readonly #broker: InMemoryBroker

  constructor(destination: string, broker: InMemoryBroker) {
    this.source = destination
    this.#broker = broker
  }

  sleepUntilReady(): Promise<void> {
    return Promise.resolve()
  }

  forward(destination: string, headers?: Record<string, string>): Promise<void> {
    this.#broker.publish(destination, { payload: undefined, headers: new Map(Object.entries(headers ?? {})) })
    return Promise.resolve()
  }

  commitSuccess(): Promise<void> {
    return Promise.resolve()
  }

  commitAdvance(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * An in-memory {@link Binder} over an {@link InMemoryBroker}. Register it on the messaging builder with
 * `.use(name, inMemoryBinder(broker))`. Two instances over two brokers prove multi-binder bridging with no
 * binder-kind branching in the core.
 */
export function inMemoryBinder(broker: InMemoryBroker = new InMemoryBroker()): (name: string) => Binder {
  return (name: string): Binder => new InMemoryBinderImpl(name, broker)
}

class InMemoryBinderImpl implements Binder {
  readonly name: string
  readonly #broker: InMemoryBroker
  readonly #unsubscribes: Array<() => void> = []

  constructor(name: string, broker: InMemoryBroker) {
    this.name = name
    this.#broker = broker
  }

  startConsumer(binding: ConsumerBinding, dispatch: Dispatch): Promise<BoundConsumer> {
    const unsubscribe = this.#broker.subscribe(binding.destination, message => {
      void dispatch(message, new InMemoryControl(binding.destination, this.#broker))
    })
    this.#unsubscribes.push(unsubscribe)
    return Promise.resolve({ stop: () => Promise.resolve(unsubscribe()) })
  }

  bindProducer(binding: ProducerBinding): Promise<BoundProducer> {
    return Promise.resolve({
      send: (message: Message): Promise<void> => Promise.resolve(this.#broker.publish(binding.destination, message)),
    })
  }

  stop(): Promise<void> {
    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe()
    }
    this.#unsubscribes.length = 0
    return Promise.resolve()
  }
}
