import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '@caffeinejs/di'
import { createApplication, ErrFeatureAlreadyInstalled } from '@caffeinejs/std'
import type { ErrConfigSlices } from '@caffeinejs/std/config'
import type { ConsumerClient, KafkaClients, ProducerClient } from './config.js'
import { ErrKafkaMissingBrokers } from './errors.js'
import { kafka } from './plugin.js'
import { kafkaTemplate, Keys } from './symbols.js'
import { KafkaTemplate } from './template.js'

// A no-op broker: never delivers, never sends. Enough to build/ready an app without a real broker.
function noopClients(): KafkaClients {
  const producer: ProducerClient = { send: () => Promise.resolve(), close: () => Promise.resolve() }
  const consumer: ConsumerClient = {
    consume: () => Promise.resolve(Object.assign(
      { async* [Symbol.asyncIterator]() {} },
      { close: () => Promise.resolve() },
    )),
    close: () => Promise.resolve(),
  }
  return { createProducer: () => producer, createConsumer: () => consumer }
}

describe('kafka feature', () => {
  it('returns the same builder from .extend()', () => {
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
    expect(app.extend(kfk, k => k.brokers('localhost:9092'))).toBe(app)
  })

  it('binds the default template and a labelled engine through configure()', async () => {
    const container = new CaffeineIoC()
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({ container })
      .extend(kfk, k => k.brokers('localhost:9092').groupId('g'))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(KafkaTemplate)).toBeInstanceOf(KafkaTemplate)
    // default template is also reachable by its instance key (name alias)
    expect(built.container.getOptional(kafkaTemplate('default'))).toBe(built.container.getOptional(KafkaTemplate))
    expect(built.container.getBindingsByLabel(Keys.KAFKA_CONTAINER)).toHaveLength(1)

    await built.close()
  })

  it('binds distinct templates for multiple named instances', async () => {
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .extend(kfk, k => k.brokers('b1').groupId('g'))
      .extend(kfk('orders'), k => k.brokers('b2').groupId('g'))

    const built = app.build()
    await built.ready()

    const def = built.container.getOptional(KafkaTemplate)
    const orders = built.container.getOptional(kafkaTemplate('orders'))
    expect(def).toBeInstanceOf(KafkaTemplate)
    expect(orders).toBeInstanceOf(KafkaTemplate)
    expect(def).not.toBe(orders)
    expect(built.container.getBindingsByLabel(Keys.KAFKA_CONTAINER)).toHaveLength(2)

    await built.close()
  })

  // Brokers may arrive from any source now, so the check runs once the whole chain has merged — which makes
  // it the slice's failure, naming the instance that could not be configured.
  it('rejects at ready() when an instance has no brokers', async () => {
    const kfk = kafka.with({ clients: noopClients() })
    const app = createApplication({})
      .extend(kfk, k => k.groupId('g')) // no brokers

    const error = await app.build().ready().then(() => undefined, (e: unknown) => e)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_SLICES' })
    expect((error as ErrConfigSlices).failures).toHaveLength(1)
    expect((error as ErrConfigSlices).failures[0].path).toBe('kafka.default')
    expect((error as ErrConfigSlices).failures[0].error).toBeInstanceOf(ErrKafkaMissingBrokers)
  })

  it('throws when the same instance is installed twice', () => {
    const kfk = kafka.with({ clients: noopClients() })
    expect(() => createApplication({}).extend(kfk).extend(kfk)).toThrow(ErrFeatureAlreadyInstalled)
    expect(() => createApplication({}).extend(kfk('orders')).extend(kfk('orders')))
      .toThrow(ErrFeatureAlreadyInstalled)
  })
})
