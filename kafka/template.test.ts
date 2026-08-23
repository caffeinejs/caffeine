import { describe, it, expect } from 'vitest'
import type { Container } from '@caffeinejs/di'
import type { KafkaClients, ProducerClient, ResolvedKafkaConfig } from './config.js'
import type { KafkaRuntime } from './runtime.js'
import { KafkaTemplate } from './template.js'

interface Sent {
  messages: unknown[]
}

function fakeRuntime(): { runtime: KafkaRuntime, sent: Sent[], created: () => number, closed: () => number } {
  const sent: Sent[] = []
  let createdCount = 0
  let closedCount = 0

  const producer: ProducerClient = {
    send(options) {
      sent.push({ messages: options.messages })
      return Promise.resolve()
    },
    close() {
      closedCount++
      return Promise.resolve()
    },
  }

  const clients: KafkaClients = {
    createProducer() {
      createdCount++
      return producer
    },
    createConsumer() {
      throw new Error('not used')
    },
  }

  const config: ResolvedKafkaConfig = {
    brokers: ['localhost:9092'],
    clientId: 'test',
    ackMode: 'auto',
    serializers: {},
    deserializers: {},
    topicProvisioning: { autoCreate: true, partitions: 1, replicas: 1 },
  }

  return {
    runtime: { name: 'test', container: {} as Container, config, clients },
    sent,
    created: () => createdCount,
    closed: () => closedCount,
  }
}

describe('KafkaTemplate', () => {
  it('sends a single value with key/headers/partition', async () => {
    const { runtime, sent } = fakeRuntime()
    const template = new KafkaTemplate(runtime)

    await template.send('orders', { id: 1 }, { key: 'k1', headers: { source: 'test' }, partition: 2 })

    expect(sent).toHaveLength(1)
    expect(sent[0].messages).toEqual([
      { topic: 'orders', value: { id: 1 }, key: 'k1', headers: { source: 'test' }, partition: 2 },
    ])
  })

  it('creates the producer lazily and reuses it across sends', async () => {
    const { runtime, created } = fakeRuntime()
    const template = new KafkaTemplate(runtime)

    expect(created()).toBe(0)
    await template.send('t', 1)
    await template.send('t', 2)
    expect(created()).toBe(1)
  })

  it('sends a fully-formed message and a batch', async () => {
    const { runtime, sent } = fakeRuntime()
    const template = new KafkaTemplate(runtime)

    await template.sendMessage({ topic: 't', value: 'v', key: 'k' })
    await template.sendBatch([{ topic: 'a', value: 1 }, { topic: 'b', value: 2 }])

    expect(sent[0].messages).toHaveLength(1)
    expect(sent[1].messages).toHaveLength(2)
  })

  it('does not send an empty batch', async () => {
    const { runtime, sent, created } = fakeRuntime()
    const template = new KafkaTemplate(runtime)

    await template.sendBatch([])
    expect(sent).toHaveLength(0)
    expect(created()).toBe(0)
  })

  it('closes the producer only when one was created', async () => {
    const { runtime, closed } = fakeRuntime()
    const template = new KafkaTemplate(runtime)

    await template.close()
    expect(closed()).toBe(0)

    await template.send('t', 1)
    await template.close()
    expect(closed()).toBe(1)
  })
})
