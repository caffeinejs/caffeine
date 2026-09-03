import { createApplication } from '@caffeinejs/std'
import { describe, it, expect } from 'vitest'

import type { ConsumerClient, KafkaClients, KafkaMessage, KafkaOutboundMessage } from './config.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { kafka } from './plugin.js'
import { kafkaTemplate } from './symbols.js'
import { KafkaTemplate } from './template.js'

// A minimal in-memory broker delivering producer sends to consumer streams by topic (isolated per file).
function toMessage(out: KafkaOutboundMessage): KafkaMessage {
  return {
    key: out.key ?? '',
    value: out.value,
    topic: out.topic,
    partition: 0,
    offset: 0n,
    timestamp: 0n,
    headers: new Map(),
    metadata: {},
    commit: () => {},
    toJSON: () => ({}) as never,
  }
}

class FakeStream {
  readonly topics: Set<string>
  #waiters: Array<(r: IteratorResult<KafkaMessage>) => void> = []
  #queue: KafkaMessage[] = []
  #closed = false

  constructor(topics: string[]) {
    this.topics = new Set(topics)
  }

  deliver(message: KafkaMessage): void {
    if (this.#closed) {
      return
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

class FakeBroker {
  readonly streams: FakeStream[] = []

  clients(): KafkaClients {
    return {
      createProducer: () => ({
        send: (options: { messages: KafkaOutboundMessage[] }) => {
          for (const message of options.messages) {
            const km = toMessage(message)
            for (const stream of this.streams) {
              if (stream.topics.has(message.topic)) {
                stream.deliver(km)
              }
            }
          }
          return Promise.resolve()
        },
        close: () => Promise.resolve(),
      }),
      createConsumer: (): ConsumerClient => ({
        consume: (options: { topics: string[] }) => {
          const stream = new FakeStream(options.topics)
          this.streams.push(stream)
          return Promise.resolve(stream)
        },
        close: () => Promise.resolve(),
      }),
    }
  }
}

let resolveNamed!: (m: KafkaMessage) => void
const namedReceived = new Promise<KafkaMessage>(res => {
  resolveNamed = res
})

@KafkaHandler({ instance: 'orders' })
class NamedConsumer {
  @KafkaListener({ topic: 'kt-named' })
  onEvent(message: KafkaMessage): void {
    resolveNamed(message)
  }
}

describe('named kafka instances', () => {
  it('routes to a named handler through the named instance and its own template', async () => {
    const broker = new FakeBroker()
    const kfk = kafka.with({ clients: broker.clients() })
    const app = createApplication({})
      .extend(kfk, k => k.brokers('localhost:9092').groupId('default-group'))
      .extend(kfk('orders'), k => k.brokers('localhost:9092').groupId('orders-group'))

    const built = app.build()
    await built.run()

    const def = built.container.get<KafkaTemplate>(KafkaTemplate)
    const orders = built.container.get<KafkaTemplate>(kafkaTemplate('orders'))
    expect(def).not.toBe(orders)

    await orders.send('kt-named', { from: 'orders' })

    const message = await namedReceived
    expect(message.value).toEqual({ from: 'orders' })

    await built.close()
  })
})
