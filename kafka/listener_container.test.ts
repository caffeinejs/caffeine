import { describe, it, expect } from 'vitest'
import { Lifetime, Scopes } from '@caffeinejs/di'
import { createApplication } from '@caffeinejs/std'
import type { ConsumerClient, KafkaClients, KafkaMessage, KafkaOutboundMessage } from './config.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { KafkaParams } from './decorators/kafka_params.js'
import { KafkaTemplate } from './template.js'
import { kafka } from './plugin.js'

// --- a minimal in-memory broker: producer sends are delivered to consumer streams by topic -----------------

function toMessage(out: KafkaOutboundMessage): KafkaMessage {
  return {
    key: out.key ?? '',
    value: out.value,
    topic: out.topic,
    partition: out.partition ?? 0,
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
  #queue: KafkaMessage[] = []
  #waiters: Array<(r: IteratorResult<KafkaMessage>) => void> = []
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

function deferred<T>(): { promise: Promise<T>, resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

// --- handler classes (module scope; unique topics to avoid cross-test/-file interference) -------------------

const singletonReceived = deferred<KafkaMessage>()

@KafkaHandler()
class SingletonConsumer {
  @KafkaListener({ topic: 'kt-orders' })
  onOrder(message: KafkaMessage): void {
    singletonReceived.resolve(message)
  }
}

const requestReceived = deferred<KafkaMessage>()

@KafkaHandler()
@Lifetime(Scopes.REQUEST)
class RequestScopedConsumer {
  @KafkaListener({ topic: 'kt-req' })
  onEvent(message: KafkaMessage): void {
    requestReceived.resolve(message)
  }
}

const errorThrown = deferred<unknown>()

@KafkaHandler()
class ThrowingConsumer {
  @KafkaListener({ topic: 'kt-err' })
  onEvent(): void {
    throw new Error('boom')
  }
}

const paramsReceived = deferred<{ value: unknown, key: string }>()

@KafkaHandler()
class ParamsConsumer {
  @KafkaListener({ topic: 'kt-params' })
  @KafkaParams(k => [k.value(), k.key()])
  onEvent(value: unknown, key: string): void {
    paramsReceived.resolve({ value, key })
  }
}

const GROUP = 'kafka-test-default'

describe('KafkaListenerContainer', () => {
  it('dispatches a produced message to the matching @KafkaListener (singleton)', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(kafka('kafka', { clients: broker.clients() }))
    app.kafka(k => k.brokers('localhost:9092').groupId(GROUP))

    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('kt-orders', { id: 7 })

    const message = await singletonReceived.promise
    expect(message.topic).toBe('kt-orders')
    expect(message.value).toEqual({ id: 7 })

    await built.close()
  })

  it('dispatches within a request scope for a request-scoped handler', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(kafka('kafka', { clients: broker.clients() }))
    app.kafka(k => k.brokers('localhost:9092').groupId(GROUP))

    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('kt-req', 'hello')

    const message = await requestReceived.promise
    expect(message.value).toBe('hello')

    await built.close()
  })

  it('routes a handler failure to the onError hook instead of crashing the stream', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(kafka('kafka', { clients: broker.clients() }))
    app.kafka(k => k.brokers('localhost:9092').groupId(GROUP).onError(error => errorThrown.resolve(error)))

    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('kt-err', 'x')

    const error = await errorThrown.promise
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('boom')

    await built.close()
  })

  it('extracts handler arguments via @KafkaParams', async () => {
    const broker = new FakeBroker()
    const app = createApplication({}).extend(kafka('kafka', { clients: broker.clients() }))
    app.kafka(k => k.brokers('localhost:9092').groupId(GROUP))

    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('kt-params', { n: 1 }, { key: 'kk' })

    const received = await paramsReceived.promise
    expect(received).toEqual({ value: { n: 1 }, key: 'kk' })

    await built.close()
  })
})
