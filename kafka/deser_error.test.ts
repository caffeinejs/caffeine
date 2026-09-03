import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import { deferred, FakeBroker } from './broker.testkit.js'
import type { DeserializationErrorRecord, KafkaMessage } from './config.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { kafka } from './plugin.js'
import { KafkaTemplate } from './template.js'

// Isolated in its own file: a value deserializer that always throws.
function throwingDeserializer(): never {
  throw new Error('cannot decode')
}

let delivered: KafkaMessage | undefined

@KafkaHandler()
class DeserConsumer {
  @KafkaListener({ topic: 'de-topic', deserializers: { value: throwingDeserializer as never } })
  onEvent(message: KafkaMessage): void {
    delivered = message
  }
}

describe('deserialization-error path', () => {
  it('routes a deserialization failure to onDeserializationError, not the listener', async () => {
    delivered = undefined
    const received = deferred<{ error: unknown; record: DeserializationErrorRecord }>()

    const broker = new FakeBroker({ applyDeserializers: true })
    const app = createApplication({}).extend(kafka.with({ clients: broker.clients() }), k =>
      k
        .brokers('b')
        .groupId('de-group')
        .onDeserializationError((error, record) => received.resolve({ error, record })),
    )
    const built = app.build()
    await built.run()

    await built.container.get<KafkaTemplate>(KafkaTemplate).send('de-topic', 'not-decodable')

    const { error, record } = await received.promise
    expect((error as Error).message).toBe('cannot decode')
    expect(record.topic).toBe('de-topic')
    expect(delivered).toBeUndefined() // listener never ran

    await built.close()
  })
})
