import type { AdminClient, ConsumerClient, ConsumerStream, KafkaClients, KafkaConsumerEvent, KafkaDeserializers, KafkaMessage, KafkaOutboundMessage, TopicSpec } from './config.js'

/** Options controlling the in-memory broker's behaviour. */
export interface FakeBrokerOptions {
  /** When true, consumers run the (wrapped) value deserializer over delivered values — used for deser-error tests. */
  applyDeserializers?: boolean
  /** Existing topics' partition counts, returned by the fake admin's `partitionCounts` (retry-topic inheritance). */
  partitions?: Record<string, number>
}

type RawDeserializer = (data?: unknown, headers?: unknown, message?: unknown) => unknown

class FakeStream implements ConsumerStream {
  readonly topics: Set<string>
  readonly #deserializers?: KafkaDeserializers
  readonly #committed: KafkaMessage[]
  #queue: KafkaMessage[] = []
  #waiters: Array<(r: IteratorResult<KafkaMessage>) => void> = []
  #closed = false

  constructor(topics: string[], committed: KafkaMessage[], deserializers?: KafkaDeserializers) {
    this.topics = new Set(topics)
    this.#committed = committed
    this.#deserializers = deserializers
  }

  deliver(out: KafkaOutboundMessage): void {
    if (this.#closed) {
      return
    }

    const headers = new Map<string, string>()
    if (out.headers instanceof Map) {
      for (const [k, v] of out.headers) {
        headers.set(k, String(v))
      }
    } else if (out.headers !== undefined) {
      for (const [k, v] of Object.entries(out.headers)) {
        headers.set(k, String(v))
      }
    }
    const partition = out.partition ?? 0
    const message: KafkaMessage = {
      key: out.key ?? '',
      value: out.value,
      topic: out.topic,
      partition,
      offset: 0n,
      timestamp: 0n,
      headers,
      metadata: {},
      commit: () => {
        this.#committed.push(message)
      },
      toJSON: () => ({}) as never,
    }

    const deserialize = this.#deserializers?.value as RawDeserializer | undefined
    if (deserialize !== undefined) {
      message.value = deserialize(out.value, headers, { topic: out.topic, partition, offset: 0n }) as never
    }

    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: message, done: false })
    } else {
      this.#queue.push(message)
    }
  }

  close(): Promise<void> {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as unknown as KafkaMessage, done: true })
    }
    return Promise.resolve()
  }

  [Symbol.asyncIterator](): AsyncIterator<KafkaMessage> {
    return {
      next: (): Promise<IteratorResult<KafkaMessage>> => {
        const queued = this.#queue.shift()
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false })
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined as unknown as KafkaMessage, done: true })
        }
        return new Promise(resolve => this.#waiters.push(resolve))
      },
    }
  }
}

/** An in-memory Kafka broker for tests: producers deliver to consumer streams by topic; commits are recorded. */
export class FakeBroker {
  readonly streams: FakeStream[] = []
  readonly committed: KafkaMessage[] = []
  readonly sent: KafkaOutboundMessage[] = []
  readonly createdTopics: TopicSpec[] = []
  readonly deletedTopics: string[] = []
  // A retained per-topic log so a consumer created after a message was produced (e.g. the dead-letter manager)
  // still reads it — the real broker's persistence, approximated.
  readonly #log = new Map<string, KafkaOutboundMessage[]>()
  readonly #eventListeners: Array<[KafkaConsumerEvent, (payload: { groupId: string }) => void]> = []
  readonly #applyDeserializers: boolean
  readonly #partitions: Record<string, number>

  constructor(options: FakeBrokerOptions = {}) {
    this.#applyDeserializers = options.applyDeserializers ?? false
    this.#partitions = options.partitions ?? {}
  }

  /** Fires a normalized lifecycle event to every consumer listener (drives lifecycle/status tests). */
  fireEvent(event: KafkaConsumerEvent, groupId = 'g'): void {
    for (const [registered, listener] of this.#eventListeners) {
      if (registered === event) {
        listener({ groupId })
      }
    }
  }

  clients(): KafkaClients {
    return {
      createProducer: () => ({
        send: (options: { messages: KafkaOutboundMessage[] }) => {
          for (const message of options.messages) {
            this.sent.push(message)
            const log = this.#log.get(message.topic) ?? []
            log.push(message)
            this.#log.set(message.topic, log)
            for (const stream of this.streams) {
              if (stream.topics.has(message.topic)) {
                stream.deliver(message)
              }
            }
          }
          return Promise.resolve()
        },
        close: () => Promise.resolve(),
      }),
      createConsumer: (): ConsumerClient => ({
        consume: options => {
          const stream = new FakeStream(
            options.topics,
            this.committed,
            this.#applyDeserializers ? options.deserializers : undefined,
          )
          this.streams.push(stream)
          // Replay any retained records for the subscribed topics, so late consumers still see them.
          for (const topic of options.topics) {
            for (const message of this.#log.get(topic) ?? []) {
              stream.deliver(message)
            }
          }
          return Promise.resolve(stream)
        },
        close: () => Promise.resolve(),
        on: (event, listener) => {
          this.#eventListeners.push([event, listener as (payload: { groupId: string }) => void])
        },
      }),
      createAdmin: (): AdminClient => ({
        createTopics: (topics: TopicSpec[]) => {
          this.createdTopics.push(...topics)
          return Promise.resolve()
        },
        partitionCounts: (topics: string[]) => {
          const counts = new Map<string, number>()
          for (const topic of topics) {
            if (this.#partitions[topic] !== undefined) {
              counts.set(topic, this.#partitions[topic])
            }
          }
          return Promise.resolve(counts)
        },
        deleteTopics: (topics: string[]) => {
          this.deletedTopics.push(...topics)
          for (const topic of topics) {
            this.#log.delete(topic)
          }
          return Promise.resolve()
        },
        close: () => Promise.resolve(),
      }),
    }
  }
}

/** A resolvable promise for asserting async delivery. */
export function deferred<T>(): { promise: Promise<T>, resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}
