import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import type { ConsumerClient, KafkaClients, ProducerClient } from './config.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { ErrKafkaUnknownInstance } from './errors.js'
import { kafka } from './plugin.js'

function noopClients(): KafkaClients {
  const producer: ProducerClient = { send: () => Promise.resolve(), close: () => Promise.resolve() }
  const consumer: ConsumerClient = {
    consume: () =>
      Promise.resolve(Object.assign({ async *[Symbol.asyncIterator]() {} }, { close: () => Promise.resolve() })),
    close: () => Promise.resolve(),
  }
  return { createProducer: () => producer, createConsumer: () => consumer }
}

// Tagged for an instance that no test below configures — isolated in its own file so it does not orphan
// handlers in other suites.
@KafkaHandler({ instance: 'ghost' })
class GhostConsumer {
  @KafkaListener({ topic: 't' })
  on(): void {}
}

describe('orphan handler detection', () => {
  it('fails fast at run() when a handler targets an unconfigured instance', async () => {
    const app = createApplication({}).extend(kafka(undefined, { clients: noopClients() }), k =>
      k.brokers('localhost:9092').groupId('g'),
    ) // only the default instance

    await expect(app.build().run()).rejects.toBeInstanceOf(ErrKafkaUnknownInstance)
  })
})
