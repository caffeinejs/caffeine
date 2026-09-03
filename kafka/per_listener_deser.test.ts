import { createApplication } from '@caffeinejs/std'
import { describe, expect, it } from 'vitest'

import { deferred, FakeBroker } from './broker.testkit.js'
import type { KafkaMessage } from './config.js'
import { KafkaHandler } from './decorators/kafka_handler.js'
import { KafkaListener } from './decorators/kafka_listener.js'
import { kafka } from './plugin.js'
import { KafkaTemplate } from './template.js'

// A tagged deserializer so we can prove the right one reached the right consumer.
function avroValue(data?: unknown): unknown {
  return { via: 'avro', data }
}

const jsonReceived = deferred<KafkaMessage>()
const avroReceived = deferred<KafkaMessage>()

@KafkaHandler()
class MixedFormatConsumer {
  @KafkaListener({ topic: 'pld-json' })
  onJson(message: KafkaMessage): void {
    jsonReceived.resolve(message)
  }

  @KafkaListener({ topic: 'pld-avro', deserializers: { value: avroValue as never } })
  onAvro(message: KafkaMessage): void {
    avroReceived.resolve(message)
  }
}

describe('per-listener deserializers', () => {
  it('runs the two listeners on separate consumers with their own deserializers', async () => {
    const broker = new FakeBroker({ applyDeserializers: true })
    const kfk = kafka.with({ clients: broker.clients() })
    const app = createApplication({})
      // Instance default = identity (so the JSON side passes through); the avro listener overrides it.
      .extend(kfk, k =>
        k
          .brokers('b')
          .groupId('pld-group')
          .deserializers({ value: ((d: unknown) => d) as never }),
      )
    const built = app.build()
    await built.run()

    // one consumer per (groupId, deserializers): instance-default JSON + the avro override
    expect(broker.streams).toHaveLength(2)

    const template = built.container.get<KafkaTemplate>(KafkaTemplate)
    await template.send('pld-json', { plain: 1 })
    await template.send('pld-avro', { raw: 2 })

    expect((await jsonReceived.promise).value).toEqual({ plain: 1 })
    expect((await avroReceived.promise).value).toEqual({ via: 'avro', data: { raw: 2 } })

    await built.close()
  })
})
